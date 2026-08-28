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
            // 智谱新版返回 prompt_tokens_details.cached_tokens（prompt_tokens 的子集），
            // 旧版字段 prompt_cache_hit_tokens 做兜底
            cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
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

// ── 工具调用解析（usage tab 计数 + tools tab 明细共用口径）──

export interface ToolCallItem { name: string; args: string }

/** 把任意 function arguments 值规整为 JSON 字符串 */
function toArgsJson(v: unknown): string {
    if (typeof v === 'string') return v
    try { return JSON.stringify(v ?? {}) } catch { return '' }
}

const TOOL_CALL_PARSERS: Record<string, (raw: string) => ToolCallItem[] | null> = {
    // chat：流式按 tool_calls index 合并增量片段；非流式取 message.tool_calls
    chat(raw) {
        const acc = new Map<number, {name: string; args: string}>()
        let nonStream: ToolCallItem[] | null = null
        for (const line of dataLines(raw)) {
            const d = safeParse(line)
            const choice = d?.choices?.[0]
            if (!choice) continue
            const msgTcs = choice.message?.tool_calls
            if (Array.isArray(msgTcs) && msgTcs.length > 0) {
                nonStream = msgTcs.map((tc: any) => ({
                    name: tc.function?.name ?? '',
                    args: toArgsJson(tc.function?.arguments),
                }))
                continue
            }
            for (const tc of choice.delta?.tool_calls ?? []) {
                if (typeof tc?.index !== 'number') continue
                const cur = acc.get(tc.index) ?? {name: '', args: ''}
                // 部分网关每 chunk 重发完整 name（非增量），须覆盖而非拼接
                cur.name = typeof tc.function?.name === 'string' ? tc.function.name : cur.name
                cur.args += typeof tc.function?.arguments === 'string' ? tc.function.arguments : ''
                acc.set(tc.index, cur)
            }
        }
        // 非 SSE 纯 JSON 响应兜底
        if (!nonStream && acc.size === 0 && !raw.includes('data:')) {
            const d = safeParse(raw.trim())
            const msgTcs = d?.choices?.[0]?.message?.tool_calls
            if (Array.isArray(msgTcs)) {
                nonStream = msgTcs.map((tc: any) => ({name: tc.function?.name ?? '', args: toArgsJson(tc.function?.arguments)}))
            }
        }
        const out = nonStream ?? (acc.size > 0 ? [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) : null)
        return out && out.length > 0 ? out : null
    },
    // responses：response.output 中 type 含 function_call 的项（流式 item 事件与最终块用 id/内容去重）
    responses(raw) {
        const seen = new Map<string, ToolCallItem>()
        for (const line of dataLines(raw)) {
            const d = safeParse(line)
            const output = d?.response?.output ?? d?.item
            for (const item of Array.isArray(output) ? output : [output]) {
                if (!item || typeof item.type !== 'string' || !item.type.includes('function_call')) continue
                const call = {name: item.name ?? '', args: toArgsJson(item.arguments)}
                const key = String(item.id ?? `${call.name}:${call.args}`)
                seen.set(key, call)
            }
        }
        return seen.size > 0 ? [...seen.values()] : null
    },
    // anthropic：content_block_start(tool_use) 定名 + content_block_delta(input_json_delta) 拼参数
    anthropic(raw) {
        const acc = new Map<number, {name: string; args: string}>()
        for (const line of dataLines(raw)) {
            const d = safeParse(line)
            if (!d) continue
            if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
                acc.set(d.index ?? 0, {name: d.content_block.name ?? '', args: ''})
            } else if (d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta') {
                const cur = acc.get(d.index ?? 0)
                if (cur) cur.args += typeof d.delta.partial_json === 'string' ? d.delta.partial_json : ''
            }
        }
        return acc.size > 0 ? [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) : null
    },
    // google：递归收集整份文档中所有 functionCall 出现点（含流式 chunk 数组）
    google(raw) {
        const out: ToolCallItem[] = []
        const walk = (v: unknown): void => {
            if (Array.isArray(v)) { v.forEach(walk); return }
            if (v === null || typeof v !== 'object') return
            const obj = v as Record<string, unknown>
            const fc = obj.functionCall
            if (fc && typeof fc === 'object') out.push({name: (fc as any).name ?? '', args: toArgsJson((fc as any).args)})
            for (const k of Object.keys(obj)) if (k !== 'functionCall') walk(obj[k])
        }
        walk(safeParse(raw.trim()))
        return out.length > 0 ? out : null
    },
}

/** 按 apiStyle 解析本次响应新增的工具调用；解析失败/无工具调用返回 null，绝不抛错 */
export function extractToolCalls(apiStyle: string, raw: string): ToolCallItem[] | null {
    try {
        if (!raw.trim()) return null
        const parser = TOOL_CALL_PARSERS[apiStyle]
        const calls = parser ? parser(raw) : null
        return calls && calls.some(c => c.name) ? calls : null
    } catch { return null }
}

/** 按 apiStyle 统计本次响应的工具调用次数；解析失败/无返回 null，绝不抛错 */
export function extractToolCallCount(apiStyle: string, raw: string): number | null {
    const calls = extractToolCalls(apiStyle, raw)
    return calls ? calls.length : null
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

// ── 正文文本提取（响应 tab「查看正文」视图）──

/** 按 apiStyle 提取 assistant 连贯正文；无内容返回 null，绝不抛错 */
const TEXT_PARSERS: Record<string, (raw: string) => string | null> = {
    // chat：顺序拼接 delta.content 增量（兼容非流式 message.content）
    chat(raw) {
        let text = ''
        for (const line of dataLines(raw)) {
            if (line === '[DONE]') continue
            const d = safeParse(line)
            const choice = d?.choices?.[0]
            const c = choice?.delta?.content ?? choice?.message?.content
            if (typeof c === 'string') text += c
        }
        // 非 SSE 纯 JSON 响应兜底
        if (!text && !raw.includes('data:')) {
            const c = safeParse(raw.trim())?.choices?.[0]?.message?.content
            if (typeof c === 'string') text = c
        }
        return text || null
    },
    // responses：流式拼 output_text.delta；非流式取 output 中 message 项的 output_text
    responses(raw) {
        const collect = (output: any): string => {
            let t = ''
            for (const item of Array.isArray(output) ? output : []) {
                if (typeof item.type !== 'string' || !item.type.includes('message')) continue
                for (const part of item.content ?? []) {
                    if (part?.type === 'output_text' && typeof part.text === 'string') t += part.text
                }
            }
            return t
        }
        let text = ''
        for (const line of dataLines(raw)) {
            const d = safeParse(line)
            if (!d) continue
            if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') text += d.delta
            text += collect(d.response?.output ?? [])
        }
        // 非 SSE 纯 JSON 响应兜底
        if (!text && !raw.includes('data:')) text += collect(safeParse(raw.trim())?.response?.output)
        return text || null
    },
    // anthropic：content_block_start(type=text) 定块的初始 text + content_block_delta(text_delta) 拼增量
    anthropic(raw) {
        const acc = new Map<number, string>()
        for (const line of dataLines(raw)) {
            const d = safeParse(line)
            if (!d) continue
            if (d.type === 'content_block_start' && d.content_block?.type === 'text') {
                acc.set(d.index ?? 0, typeof d.content_block.text === 'string' ? d.content_block.text : '')
            } else if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
                const cur = acc.get(d.index ?? 0)
                if (cur !== undefined && typeof d.delta.text === 'string') acc.set(d.index ?? 0, cur + d.delta.text)
            }
        }
        return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join('') || null
    },
    // google：candidates[0].content.parts 的 text 拼接
    google(raw) {
        const parts = safeParse(raw.trim())?.candidates?.[0]?.content?.parts
        if (!Array.isArray(parts)) return null
        const text = parts.filter(p => typeof p?.text === 'string').map(p => p.text).join('')
        return text || null
    },
}

export function extractTextContent(apiStyle: string, raw: string): string | null {
    try {
        if (!raw.trim()) return null
        const parser = TEXT_PARSERS[apiStyle]
        const text = parser ? parser(raw) : null
        return text || null
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
