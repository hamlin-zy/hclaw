/**
 * LLM 响应 usage 解析（跨主进程/renderer 共享，唯一维护点）。
 *
 * 按 apiStyle 从 res.raw 文本解析 token 用量；解析失败返回 null，绝不抛错。
 * 主进程投影（computeTokens）与日志窗口详情面板（usage tab）共用此实现。
 */

export interface TokenUsage {
    inputTokens?: number; outputTokens?: number
    cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number
}

const PARSERS: Record<string, (raw: string) => TokenUsage | null> = {
    chat(raw) {
        const usage = lastJsonDataLine(raw, d => d.usage)
        if (!usage) return null
        return {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            cacheReadTokens: usage.prompt_cache_hit_tokens,
            cacheWriteTokens: usage.prompt_cache_miss_tokens,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        }
    },
    responses(raw) {
        const u = lastJsonDataLine(raw, d => d.type === 'response.completed' ? d.response?.usage : undefined)
        if (!u) return null
        return {inputTokens: u.input_tokens, outputTokens: u.output_tokens,
            cacheReadTokens: u.input_tokens_details?.cached_tokens}
    },
    anthropic(raw) {
        let out: TokenUsage | null = null
        for (const line of dataLines(raw)) {
            const d = safeParse(line)
            if (!d) continue
            if (d.type === 'message_start' && d.message?.usage) {
                out = {inputTokens: d.message.usage.input_tokens,
                    outputTokens: 0,
                    cacheReadTokens: d.message.usage.cache_read_input_tokens,
                    cacheWriteTokens: d.message.usage.cache_creation_input_tokens}
            } else if (d.type === 'message_delta' && d.usage && out) {
                out.outputTokens = d.usage.output_tokens
            }
        }
        return out
    },
    google(raw) {
        const d = safeParse(raw.trim())   // Google 非流式 JSON 或 streamGenerateContent 数组尾块
        const u = Array.isArray(d) ? d[d.length - 1]?.usageMetadata : d?.usageMetadata
        if (!u) return null
        return {inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount,
            reasoningTokens: u.thoughtsTokenCount}
    },
}

/** 按 apiStyle 从 res.raw 文本解析 usage；解析失败返回 null，绝不抛错 */
export function extractUsage(apiStyle: string, raw: string): TokenUsage | null {
    try {
        const parser = PARSERS[apiStyle]
        if (!parser || !raw.trim()) return null
        const r = parser(raw)
        return r && Object.values(r).some(v => typeof v === 'number') ? r : null
    } catch { return null }
}

function dataLines(raw: string): string[] {
    return raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
}
function safeParse(line: string): any | null {
    try { return JSON.parse(line) } catch { return null }
}
function lastJsonDataLine<T>(raw: string, pick: (d: any) => T | undefined | null): T | null {
    const lines = dataLines(raw).reverse()
    for (const l of lines) {
        if (l === '[DONE]') continue
        const d = safeParse(l)
        if (!d) continue
        const v = pick(d)
        if (v) return v
    }
    return null
}
