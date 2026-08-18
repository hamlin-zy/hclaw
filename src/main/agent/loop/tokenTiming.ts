// 首 token 边界与解码时序/速率纯函数（供 execute.ts 采集循环调用）。
// 抽为纯函数便于单测：团队约定只测纯函数，避开 execute.ts 的复杂 generator。

import type {StreamChunk} from '../model/types'
import {MIN_DECODE_MS} from '@shared/types'

/**
 * 一个 stream chunk 是否携带可见模型输出（首 token 边界）。
 * 空 text/thinking/reasoning、usage、done、error、thinking_signature 均不算。
 *
 * tool_use 不作为首 token 边界：OpenAI 系适配器在流末尾才 flush tool_use
 * （finish_reason 分支统一 yield），若将其计为首 token，纯工具调用轮次会得到
 * firstTokenTime≈attemptEnd、decodeMs≈1ms 的虚短时长，吞吐爆表（DB 实测 79 万 t/s）。
 * 纯工具轮次没有"解码文本"过程，不应产生吞吐统计。
 */
export function isTokenDelta(chunk: StreamChunk): boolean {
    switch (chunk.type) {
        case 'text':
        case 'thinking':
        case 'reasoning':
            return chunk.content !== ''
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
    /** 解码吞吐（t/s）：outputTokens ÷ (decodeMs/1000)。 */
    tokensPerSecond: number
}

/**
 * 由三个时间戳 + 服务商上报的 outputTokens 计算时序与速率。
 * 负时长 clamp 到 0；decodeMs<=0 时吞吐为 0。
 *
 * 防爆表下限：decodeMs 短于 500ms 时按 500ms 计算吞吐。
 * 背景：AI 网关 / 流式 SDK 的首 token 边界经常虚短（DB 实测 decode_ms=1 却上报
 * 数百 output_tokens，理论速率可达 79 万 t/s），导致徽章偶发 190000 t/s 级异常值。
 * 500ms 是"非真实解码区间"的保守下限，实际解码速率远低于此上限。
 */
export function computeTokenTiming(
    attemptStartTime: number,
    firstTokenTime: number,
    attemptEnd: number,
    outputTokens: number,
): TokenTiming {
    const ttftMs = Math.max(0, firstTokenTime - attemptStartTime)
    const decodeMs = Math.max(0, attemptEnd - firstTokenTime)
    // decodeMs 为 0 时吞吐为 0；否则不低于 MIN_DECODE_MS，防止首 token 边界虚短导致 t/s 爆表
    const effectiveDecodeMs = decodeMs > 0 ? Math.max(MIN_DECODE_MS, decodeMs) : 0
    const tokensPerSecond = effectiveDecodeMs > 0 ? outputTokens / (effectiveDecodeMs / 1000) : 0
    return {ttftMs, decodeMs, tokensPerSecond}
}
