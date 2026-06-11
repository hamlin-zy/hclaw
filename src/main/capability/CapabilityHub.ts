/**
 * CapabilityHub — 统一能力中心
 *
 * 核心单例，管理所有 Agent/Skill/Command 的统一注册与查询。
 *
 * 关键设计：
 *   1. pluginIndex 按插件名索引 → onPluginStateChange 批量更新 O(n)
 *   2. searchText 预计算 → 搜索时无需每次拼接字符串
 *   3. 幂等注册 → 同 id 重复 register 会覆盖旧条目
 *   4. EventEmitter → 预留订阅/推送机制（Phase 1 不使用）
 */

import { EventEmitter } from 'events'
import {
    CapabilityEntry,
    CapabilityFilter,
    CapabilityStats,
    CapabilityType,
    CapabilitySource,
    PluginGroup,
} from './types'

export class CapabilityHub extends EventEmitter {
    /** 能力条目主存储：id → entry */
    private entries = new Map<string, CapabilityEntry>()

    /** 插件索引：pluginName → entryIds（用于 onPluginStateChange 批量更新） */
    private pluginIndex = new Map<string, Set<string>>()

    // ─── 写入 ───────────────────────────────────

    /**
     * 注册单个能力条目（幂等：同 id 覆盖旧值）
     */
    register(entry: CapabilityEntry): void {
        // 计算搜索文本
        if (!entry.searchText) {
            entry.searchText = `${entry.name} ${entry.description}`.toLowerCase()
        }

        // 清理旧插件索引（如果 id 已存在但插件变了）
        const old = this.entries.get(entry.id)
        if (old?.pluginName && old.pluginName !== entry.pluginName) {
            this.removeFromPluginIndex(old.pluginName, entry.id)
        }

        this.entries.set(entry.id, entry)

        // 更新插件索引
        if (entry.pluginName) {
            this.addToPluginIndex(entry.pluginName, entry.id)
        }
    }

    /**
     * 批量注册（性能优化：批量插入后统一通知）
     */
    registerBatch(entries: CapabilityEntry[]): void {
        for (const entry of entries) {
            if (!entry.searchText) {
                entry.searchText = `${entry.name} ${entry.description}`.toLowerCase()
            }
            this.entries.set(entry.id, entry)
            if (entry.pluginName) {
                this.addToPluginIndex(entry.pluginName, entry.id)
            }
        }
    }

    /**
     * 注销单个能力
     */
    unregister(id: string): void {
        const entry = this.entries.get(id)
        if (!entry) return

        if (entry.pluginName) {
            this.removeFromPluginIndex(entry.pluginName, id)
        }
        this.entries.delete(id)
    }

    /**
     * 注销某插件下的所有能力
     */
    unregisterByPlugin(pluginName: string): void {
        const ids = this.pluginIndex.get(pluginName)
        if (!ids) return

        for (const id of ids) {
            this.entries.delete(id)
        }
        this.pluginIndex.delete(pluginName)
    }

    /**
     * 清空所有条目
     */
    clear(): void {
        this.entries.clear()
        this.pluginIndex.clear()
    }

    /**
     * 清空 + 通知（用于全量刷新场景）
     */
    reset(): void {
        this.clear()
        this.emit('changed')
    }

    // ─── 插件状态变更（核心方法）─────────────────

    /**
     * 插件启用/禁用时调用。
     * 批量更新该插件下所有条目的 pluginEnabled 字段。
     *
     * 复杂度：O(n) where n = 该插件的条目数
     */
    onPluginStateChange(pluginName: string, enabled: boolean): void {
        const ids = this.pluginIndex.get(pluginName)
        if (!ids || ids.size === 0) return

        for (const id of ids) {
            const entry = this.entries.get(id)
            if (entry) {
                entry.pluginEnabled = enabled
            }
        }

        this.emit('changed', { reason: 'plugin-state-change', pluginName, enabled })
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
     * 按插件分组（用于 SkillsDialog 的"插件"标签）
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

    // ─── 订阅（Phase 1 预留，当前方案 A 不使用） ───

    /**
     * 注册变更监听器。
     * 返回取消订阅函数。
     */
    onChange(listener: () => void): () => void {
        this.on('changed', listener)
        return () => this.off('changed', listener)
    }

    // ─── 私有辅助 ───────────────────────────────

    private addToPluginIndex(pluginName: string, id: string): void {
        const set = this.pluginIndex.get(pluginName)
        if (set) {
            set.add(id)
        } else {
            this.pluginIndex.set(pluginName, new Set([id]))
        }
    }

    private removeFromPluginIndex(pluginName: string, id: string): void {
        const set = this.pluginIndex.get(pluginName)
        if (set) {
            set.delete(id)
            if (set.size === 0) {
                this.pluginIndex.delete(pluginName)
            }
        }
    }
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
