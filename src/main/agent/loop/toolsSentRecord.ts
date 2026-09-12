/**
 * 每会话「上一轮实际发送给 LLM 的 tools 名称」记录。
 *
 * tools 数组在编码请求中位于 messages 之前：会话中途变化会使前缀从 tools 段失配，
 * 已积累的 prompt 缓存全部作废。该记录供 tools 变动门在新请求发出前比较、拦截。
 *
 * ★ 跨 run 持久化：每次用户发消息都会重建 Worker（manager.impl.ts new Worker），
 *   模块级 Map 会随进程归零 → 门在主场景永不生效。故落 system_settings：
 *   每个会话一个独立 key（`tools_sent_last:<conversationId>`），值为 JSON string[]。
 *
 *   选独立 key 而非单 key 聚合 JSON Record<convId, string[]> 的理由：多个会话的 Worker
 *   可并发读写，聚合方案的 read-modify-write 会互相覆盖（丢记录 → 偶发漏拦截）；
 *   独立 key 无跨会话竞争，且天然「每会话只存一条」，无 JSON 膨胀。
 *
 * ★ 记录点必须落在「实际发送」处（execute.ts 算出 toolsToSend 后），
 *   否则 400 降级路径（实际发 preCapabilityToolDefinitions）与基线不符。
 */
import {systemSettingsRepo} from '../../repositories/sqlite/systemSettingsRepository'

const TOOLS_SENT_KEY_PREFIX = 'tools_sent_last:'

function keyFor(conversationId: string): string {
    return `${TOOLS_SENT_KEY_PREFIX}${conversationId}`
}

/** 读取上一轮实际发送的工具名；无记录/解析失败返回 undefined。 */
export function getLastSentToolNames(conversationId: string): string[] | undefined {
    try {
        const raw = systemSettingsRepo.get(keyFor(conversationId))
        if (!raw) return undefined
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) && parsed.every(n => typeof n === 'string') ? parsed as string[] : undefined
    } catch {
        return undefined
    }
}

/** 记录本轮实际发送的工具名（覆盖上一轮）。 */
export function recordLastSentToolNames(conversationId: string, names: string[]): void {
    try {
        systemSettingsRepo.set(keyFor(conversationId), JSON.stringify(names))
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
