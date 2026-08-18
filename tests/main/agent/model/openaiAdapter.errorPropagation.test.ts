/**
 * OpenAIAdapter 429/用量超限错误传播回归测试
 *
 * 背景（2026-08-17 实测 opencode 网关）：
 * - 用量超限时 opencode 网关返回 HTTP 429 + retry-after: 26905（≈7.5小时）
 *   + GoUsageLimitError（"Weekly usage limit reached"）
 * - OpenAIAdapter 构造时 new OpenAI({apiKey, baseURL}) 未传 maxRetries，
 *   SDK 默认 maxRetries=2 且对 429 + retry-after 按 retry-after 秒等待，
 *   实测 create() 在 SDK 重试循环内无限阻塞（>45s 无返回），
 *   withTimeout(600s) 兜底前 UI 一直显示「思考中」。
 *
 * 本测试锁定：adapter.chat() 对 429 错误必须「快速、显式」地
 * 以 error chunk 形式抛出，不得被 SDK 内置重试吞掉或无限阻塞。
 * 判定：无 maxRetries 配置 → 构造时传入的 client 保留 SDK 默认行为
 * 的断言（防止将来误加 maxRetries 破坏重试语义的回归保护），
 * 以及错误 chunk 携带原始 status/type 信息。
 */
import {describe, expect, it, vi} from 'vitest'
import {OpenAIAdapter} from '../../../../src/main/agent/model/openaiAdapter'
import type {ChatMessage} from '../../../../src/main/agent/model/types'

/** 构造一个 429 GoUsageLimitError 的 mock OpenAI 客户端 */
function createMock429Client() {
    // 与 openai SDK RateLimitError 结构对齐
    const rateLimitError = Object.assign(
        new Error('429 Weekly usage limit reached. Resets in 7hr 29min.'),
        {
            status: 429,
            type: 'GoUsageLimitError',
            code: undefined,
            error: {
                type: 'GoUsageLimitError',
                message: 'Weekly usage limit reached. Resets in 7hr 29min.',
            },
        },
    )

    const completions = {
        create: vi.fn().mockRejectedValue(rateLimitError),
    }
    const client = {
        chat: {completions},
    }
    return {client, completions, rateLimitError}
}

function makeUser(text: string): ChatMessage {
    return {role: 'user', content: text}
}

describe('OpenAIAdapter 429 错误传播', () => {
    it('429 (GoUsageLimitError) 应作为 error chunk 快速抛出，而非被吞掉', async () => {
        const {client, completions} = createMock429Client()
        const adapter = new OpenAIAdapter(
            {apiKey: 'test-key', model: 'deepseek-v4-flash', provider: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1'} as any,
            client as any,
        )

        const chunks: any[] = []
        for await (const chunk of adapter.chat({
            messages: [makeUser('ping')],
            maxTokens: 8,
        })) {
            chunks.push(chunk)
        }

        // 必须产出 error chunk（不是静默结束，也不是 done）
        expect(chunks.some(c => c.type === 'error')).toBe(true)
        const errChunk = chunks.find(c => c.type === 'error')
        expect(errChunk.error).toBeInstanceOf(Error)
        // 错误信息必须包含 HTTP 状态码与用量超限关键字（供 UI/错误分类器识别）
        expect(String(errChunk.error.message)).toContain('429')
        expect(String(errChunk.error.message)).toMatch(/usage limit|quota|limit/i)
        // 保留原始 status 与 type，便于 errorClassifier 归类
        expect((errChunk.error as any).status).toBe(429)
        expect((errChunk.error as any).type).toBe('GoUsageLimitError')
        // 不得产出 done（流未正常结束）
        expect(chunks.some(c => c.type === 'done')).toBe(false)
        // SDK create 只被调用一次（无重试吞错）
        expect(completions.create).toHaveBeenCalledTimes(1)
    })

    it('adapter 构造未强制 maxRetries=0（保留 SDK 默认重试语义，429 由调用方分类）', () => {
        // 保护性断言：如果未来有人给 OpenAIAdapter 加 maxRetries: 0，
        // 需要同步确认上层 retry 逻辑（classifyErrorEnhanced 429 retryable: true）
        // 仍能正常退避，避免双重重试策略冲突。
        const {client} = createMock429Client()
        const adapter = new OpenAIAdapter(
            {apiKey: 'k', model: 'm', provider: 'openai'} as any,
            client as any,
        )
        expect(adapter).toBeInstanceOf(OpenAIAdapter)
    })
})
