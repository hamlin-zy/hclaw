export type LlmTraceStatus = 'ok' | 'error' | 'aborted'
/** unknown = 未设上下文的意外路径兜底 */
export type LlmTraceContextKind = 'main' | 'subAgent' | 'background' | 'planning' | 'unknown'

/** index.jsonl 每行一条。语义约定：
 *  - aborted 仅指用户主动取消；网络中断一律 error 且 truncated=true
 *  - 本行存在 ⟺ 该调用记录完整（req/res 先落盘，本行最后写） */
export interface LlmCallRecord {
    id: string
    ts: number
    conversationId: string
    turn: number
    step: number
    attempt: number
    context: LlmTraceContextKind
    provider: string
    model: string
    apiStyle: string
    status: LlmTraceStatus
    firstByteMs: number
    totalMs: number
    truncated?: boolean
    error?: {message: string}
    resEncoding?: string
    reqFile: string
    resFile?: string
}

const SENSITIVE = /authorization|x-api-key|api-key|x-goog-api-key|cookie/i

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE.test(k) ? '***REDACTED***' : v
    return out
}

/** 类型守卫：LlmCallRecord 最小形状判定（id/ts/status），paused 等事件对象不会误判 */
export function isLlmCallRecord(x: unknown): x is LlmCallRecord {
    return typeof x === 'object' && x !== null
        && typeof (x as {id?: unknown}).id === 'string'
        && typeof (x as {ts?: unknown}).ts === 'number'
        && typeof (x as {status?: unknown}).status === 'string'
}