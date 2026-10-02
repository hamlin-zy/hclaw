/**
 * 每会话「上一轮实际发送给 LLM 的 tools 名称 + 当轮配置模型名」记录。
 *
 * tools 数组在编码请求中位于 messages 之前：会话中途变化会使前缀从 tools 段失配，
 * 已积累的 prompt 缓存全部作废。该记录供 tools 变动门在新请求发出前比较、拦截。
 *
 * ★ 跨 run 持久化：每次用户发消息都会重建 Worker（manager.impl.ts new Worker），
 *   模块级 Map 会随进程归零 → 门在主场景永不生效。故落 system_settings：
 *   每个会话一个独立 key（`tools_sent_last:<conversationId>`），值为
 *   JSON `{model, names}` —— model 为当轮 selectModelForTurn 解析出的配置模型名，
 *   用于判定「本轮是否发生了模型切换」（跨模型时 prompt cache 本就不共享，
 *   图片工具随能力互换无需拦截，见 MODEL_CAPABILITY_SWITCHED_TOOLS）。
 *
 *   选独立 key 而非单 key 聚合 JSON Record<convId, string[]> 的理由：多个会话的 Worker
 *   可并发读写，聚合方案的 read-modify-write 会互相覆盖（丢记录 → 偶发漏拦截）；
 *   独立 key 无跨会话竞争，且天然「每会话只存一条」，无 JSON 膨胀。
 *
 * ★ 记录点必须落在「实际发送」处（execute.ts 算出 toolsToSend 后），
 *   否则 400 降级路径（实际发 preCapabilityToolDefinitions）与基线不符。
 */
import {systemSettingsRepo} from '../../repositories/sqlite/systemSettingsRepository'
import {MODEL_CAPABILITY_SWITCHED_TOOLS} from '@shared/alwaysOnTools'

const TOOLS_SENT_KEY_PREFIX = 'tools_sent_last:'

/** 上一轮实际发送的 tools 记录（model = 当轮配置模型名，names = 实际发送的工具名，顺序即编码顺序）。 */
export interface LastSentToolsRecord {
    model: string
    names: string[]
}

function keyFor(conversationId: string): string {
    return `${TOOLS_SENT_KEY_PREFIX}${conversationId}`
}

/**
 * 读取上一轮实际发送的工具名记录。
 * 仅当解析出对象且 model 为 string、names 为 string[] 时返回；
 * 旧格式（裸数组，无 model）、损坏 JSON、缺字段一律返回 undefined（视为「无记录」）。
 */
export function getLastSentToolsRecord(conversationId: string): LastSentToolsRecord | undefined {
    try {
        const raw = systemSettingsRepo.get(keyFor(conversationId))
        if (!raw) return undefined
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
        const {model, names} = parsed as {model?: unknown; names?: unknown}
        if (typeof model !== 'string') return undefined
        if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) return undefined
        return {model, names: names as string[]}
    } catch {
        return undefined
    }
}

/** 记录本轮实际发送的工具名与当轮配置模型名（覆盖上一轮）。 */
export function recordLastSentToolNames(conversationId: string, names: string[], model: string): void {
    try {
        systemSettingsRepo.set(keyFor(conversationId), JSON.stringify({model, names}))
    } catch {
        // 记录失败只削弱拦截能力，不应影响主流程
    }
}

/**
 * 判定两组工具名是否完全一致（★ 顺序敏感）。
 * tools 数组按固定顺序编码进请求前缀，顺序变化与集合变化同样导致缓存失配。
 */
export function isSameToolNameSequence(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}

/**
 * tools 变动门判据（纯函数，便于单测）：
 *
 * 放行（confirm=false）的充要条件（除「首轮无记录」「序列完全相同」外）：
 *   上一轮模型 ≠ 本轮配置模型  且  差异集合 ⊆ MODEL_CAPABILITY_SWITCHED_TOOLS
 * 即：会话中途切换模型（视觉 ⇄ 非视觉）导致图片工具互换时，不打断用户——
 * 跨模型 prompt cache 本就不共享，互换不产生额外缓存重建成本。
 *
 * 其余情况一律 confirm=true（照旧弹窗）：
 * - prev 为 undefined → 首轮，不弹（confirm=false）
 * - 序列完全一致（含顺序）→ 不弹
 * - ★ 模型未变 + 图片工具互换（差异同样只有这两个）→ 仍弹：
 *   这是 400 降级 / 自愈恢复路径（同一模型下工具集回摆），缓存确实会全量失效，须提醒用户。
 * - 含任何非图片工具差异 → 弹
 * - ★ 模型变化 + 集合相同仅顺序不同 → 放行（added/removed 均为空 → 空集 every 为 true）。
 *   可接受：跨模型本就不共享缓存，顺序变化不会造成额外损失。
 */
export function evaluateToolsChange(
    prev: LastSentToolsRecord | undefined,
    curr: string[],
    currentModel: string,
): { confirm: boolean; added: string[]; removed: string[] } {
    if (!prev) return {confirm: false, added: [], removed: []}
    if (isSameToolNameSequence(prev.names, curr)) return {confirm: false, added: [], removed: []}

    const added = curr.filter(n => !prev.names.includes(n))
    const removed = prev.names.filter(n => !curr.includes(n))

    const modelSwitched = prev.model !== currentModel
    const onlyCapabilitySwitched = [...added, ...removed].every(n => MODEL_CAPABILITY_SWITCHED_TOOLS.has(n))
    if (modelSwitched && onlyCapabilitySwitched) return {confirm: false, added, removed}

    return {confirm: true, added, removed}
}
