/**
 * CapabilityHub — 统一能力中心
 *
 * 核心单例，管理所有 Agent/Skill/Command 的统一注册与查询。
 *
 * 关键设计：
 *   1. 对外接口收敛为：只读查询组 + replaceAll 写 seam + onChanged 订阅
 *   2. 全量投影：由 powerManager.refresh() 收集全部条目后单次 replaceAll 写入
 *   3. 变更门控：id 集合 + 条目浅签名比对，无变化不发信号
 *      （字段集＝投影可见性字段，见 entrySignature；`content` 正文刻意不参与）
 *   4. 变更信号载荷仅 { seq }（单调序号），消费端收信号后整表重取
 *   5. searchText 预计算 → 搜索时无需每次拼接字符串
 */

import { EventEmitter } from 'events'
import {
    CapabilityEntry,
    CapabilityFilter,
    CapabilityStats,
    CapabilityType,
    PluginGroup,
} from './types'

export class CapabilityHub extends EventEmitter {
    /** 能力条目主存储：id → entry */
    private entries = new Map<string, CapabilityEntry>()

    /** 单调递增的变更序号，作为 onChanged 信号载荷 */
    private seq = 0

    // ─── 写入 ───────────────────────────────────

    /**
     * 全量替换当前投影（唯一写入口）。
     *
     * 与当前投影比对（id 集合 + 每个 entry 的浅签名）：
     *   - 无变化 → 什么都不做（不发信号、不改状态）
     *   - 有变化 → 更新存储、seq++、emit { seq }
     *
     * 插件归属（pluginName / pluginEnabled）由 entry 自带，无需额外索引。
     */
    replaceAll(entries: CapabilityEntry[]): void {
        const next = new Map<string, CapabilityEntry>()
        for (const entry of entries) {
            if (!entry.searchText) {
                entry.searchText = `${entry.name} ${entry.description}`.toLowerCase()
            }
            next.set(entry.id, entry)
        }

        if (!this.hasChanged(next)) return

        this.entries = next
        this.seq++
        this.emit('changed', { seq: this.seq })
    }

    // ─── 查询 ───────────────────────────────────

    /**
     * 按条件过滤查询
     */
    query(filter: CapabilityFilter = {}): CapabilityEntry[] {
        let result = Array.from(this.entries.values())

        if (filter.types && filter.types.length > 0) {
            const typeSet = new Set(filter.types)
            result = result.filter(e => typeSet.has(e.type))
        }

        if (filter.sources && filter.sources.length > 0) {
            const sourceSet = new Set(filter.sources)
            result = result.filter(e => sourceSet.has(e.source))
        }

        if (filter.enabled !== undefined) {
            result = result.filter(e => e.enabled === filter.enabled)
        }

        if (filter.pluginName !== undefined) {
            result = result.filter(e => e.pluginName === filter.pluginName)
        }

        return result
    }

    /**
     * 按类型获取所有条目
     */
    getByType(type: CapabilityType): CapabilityEntry[] {
        return this.query({ types: [type] })
    }

    /**
     * 搜索：预计算 searchText + 子序列匹配
     *
     * 用于 Ctrl+K 命令面板。
     * 返回按相关度排序的结果。
     */
    search(query: string): CapabilityEntry[] {
        const q = query.toLowerCase().trim()
        if (!q) {
            return Array.from(this.entries.values())
        }

        const results: Array<{ entry: CapabilityEntry; score: number }> = []

        for (const entry of this.entries.values()) {
            const st = entry.searchText
            let score = 0

            if (st.startsWith(q)) {
                score = 100
            } else if (st.includes(q)) {
                score = 80
            } else if (isSubsequence(st, q)) {
                score = 60
            } else {
                continue
            }

            // 启用优先
            if (entry.enabled) score += 20

            results.push({ entry, score })
        }

        results.sort((a, b) => b.score - a.score)
        return results.map(r => r.entry)
    }

    /**
     * 按插件分组（用于 SkillsDialog 的"插件"标签）。
     * 插件归属直接从 entries 派生（entry.pluginName），无独立索引。
     */
    getPluginGroups(type?: CapabilityType): PluginGroup[] {
        const pluginMap = new Map<string, CapabilityEntry[]>()

        for (const entry of this.entries.values()) {
            if (type && entry.type !== type) continue
            if (!entry.pluginName) continue

            const list = pluginMap.get(entry.pluginName) || []
            list.push(entry)
            pluginMap.set(entry.pluginName, list)
        }

        const groups: PluginGroup[] = []
        for (const [name, entries] of pluginMap) {
            // 插件的处于启用状态 = 该插件下至少一条 entry 的 pluginEnabled 为 true
            const enabled = entries.some(e => e.pluginEnabled === true)
            groups.push({ name, enabled, entries })
        }

        // 已启用的在前
        groups.sort((a, b) => Number(b.enabled) - Number(a.enabled))
        return groups
    }

    /**
     * 获取统计信息
     */
    getStats(): CapabilityStats {
        const stats: CapabilityStats = {
            total: 0,
            enabled: 0,
            byType: { skill: 0, agent: 0, command: 0 },
            bySource: { builtin: 0, user: 0, plugin: 0 },
        }

        for (const entry of this.entries.values()) {
            stats.total++
            if (entry.enabled) stats.enabled++
            stats.byType[entry.type]++
            stats.bySource[entry.source]++
        }

        return stats
    }

    /**
     * 获取单个条目
     */
    get(id: string): CapabilityEntry | undefined {
        return this.entries.get(id)
    }

    /**
     * 条目总数
     */
    get size(): number {
        return this.entries.size
    }

    // ─── 订阅 ───────────────────────────────────

    /**
     * 订阅变更信号。载荷仅为 { seq }（单调序号），消费端收信号后整表重取。
     * 返回取消订阅函数。
     */
    onChanged(listener: (e: { seq: number }) => void): () => void {
        this.on('changed', listener)
        return () => this.off('changed', listener)
    }

    // ─── 私有辅助 ───────────────────────────────

    /**
     * 比对下一投影是否与当前投影不同（id 集合 + 条目浅签名）。
     * 浅签名只覆盖影响投影可见性的字段，不序列化 content（技能正文/系统提示，
     * 可达数十 KB），且不依赖对象键插入顺序。
     */
    private hasChanged(next: Map<string, CapabilityEntry>): boolean {
        if (next.size !== this.entries.size) return true
        for (const [id, entry] of next) {
            const current = this.entries.get(id)
            if (!current) return true
            if (entrySignature(current) !== entrySignature(entry)) return true
        }
        return false
    }
}

/**
 * 条目浅签名：显式拼接关键字段，避免 JSON.stringify(entry) 的两处问题——
 * ① 整体序列化 content；② 对对象键插入顺序敏感（键序不同会误发信号）。
 *
 * 门控字段集 = 「影响投影可见性的字段」：
 *  - 含 `hasArgs`：渲染端**直接从 Hub 投影消费**该派生标记（CommandsDialog 构造插件命令
 *    列表时取 `c.hasArgs`，用于命令面板的参数提示），正文里新增/移除 `$ARGUMENTS`
 *    会翻转它 —— 不入签名则只改命令正文时列表滞留旧值。它是布尔量，无序列化成本。
 *  - 不含 `content`（技能正文/系统提示，可达数十 KB）：正文与参数（args）的变更由各自
 *    写路径的权威重取覆盖，为此付出全量序列化代价不划算（见 CapabilityHub.test.ts
 *    「content 不参与浅签名」用例）。
 */
function entrySignature(e: CapabilityEntry): string {
    return [
        e.id,
        e.type,
        e.name,
        e.description,
        e.source,
        e.enabled,
        e.pluginName,
        e.pluginEnabled,
        e.hasArgs,
        (e.allowedTools ?? []).join(','),
    ]
        .map(v => (v === undefined ? '' : String(v)))
        .join('|')
}

/** 全局单例 */
export const capabilityHub = new CapabilityHub()

// ─── 辅助函数 ───────────────────────────────────

/** 子序列匹配（fuzzy search）：q 的字符在 text 中按顺序出现 */
function isSubsequence(text: string, q: string): boolean {
    let qi = 0
    for (let ti = 0; ti < text.length && qi < q.length; ti++) {
        if (text[ti] === q[qi]) qi++
    }
    return qi === q.length
}
