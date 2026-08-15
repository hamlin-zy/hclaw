// 首 token 边界与解码时序/速率纯函数（供 execute.ts 采集循环调用）。
// 抽为纯函数便于单测：团队约定只测纯函数，避开 execute.ts 的复杂 generator。

import type {StreamChunk} from '../model/types'

/**
 * 一个 stream chunk 是否携带可见模型输出（首 token 边界）。
 * 空 text/thinking/reasoning、usage、done、error、thinking_signature 均不算。
 */
export function isTokenDelta(chunk: StreamChunk): boolean {
    switch (chunk.type) {
        case 'text':
        case 'thinking':
        case 'reasoning':
            return chunk.content !== ''
        case 'tool_use':
            return true
        default:
            return false
    }
}

/** 一次成功 attempt 的解码时序与吞吐。 */
export interface TokenTiming {
    /** 首字延迟（毫秒）：attemptStartTime → firstTokenTime。 */
    ttftMs: number
    /** 纯解码时长（毫秒）：firstTokenTime → attemptEnd。 */
    decodeMs: number
    /** 解码吞吐（tok/s）：outputTokens ÷ (decodeMs/1000)。 */
    tokensPerSecond: number
}

/**
 * 由三个时间戳 + 服务商上报的 outputTokens 计算时序与速率。
 * 负时长 clamp 到 0；decodeMs<=0 时吞吐为 0。
 */
export function computeTokenTiming(
    attemptStartTime: number,
    firstTokenTime: number,
    attemptEnd: number,
    outputTokens: number,
): TokenTiming {
    const ttftMs = Math.max(0, firstTokenTime - attemptStartTime)
    const decodeMs = Math.max(0, attemptEnd - firstTokenTime)
    const tokensPerSecond = decodeMs > 0 ? outputTokens / (decodeMs / 1000) : 0
    return {ttftMs, decodeMs, tokensPerSecond}
}
