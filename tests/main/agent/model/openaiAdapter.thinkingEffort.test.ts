/**
 * OpenAIAdapter thinkingEffort 按端点来源透传策略测试
 *
 * 策略：
 * - 官方端点（baseUrl 为空或含 api.openai.com）：auto → medium；xhigh/max 原样透传
 * - 第三方兼容网关：auto/xhigh/max → high
 * - 其他档位原样透传；映射/降级时 logger.info 记录 model + original + sent
 */
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {OpenAIAdapter} from '../../../../src/main/agent/model/openaiAdapter'
import {OllamaAdapter} from '../../../../src/main/agent/model/ollamaAdapter'
import {logger} from '../../../../src/main/agent/logger'

type ApiStyle = 'chat' | 'responses'

/** mock.create 的 vi.fn 泛型推断为空参数元组，取首参需 any 转换 */
function firstCall(fn: any): any {
    return fn.mock.calls[0]?.[0]
}
function lastCall(fn: any): any {
    return fn.mock.calls.at(-1)?.[0]
}

function makeMockClient(apiStyle: ApiStyle) {
    if (apiStyle === 'chat') {
        const create = vi.fn(async function* () {})
        return {chat: {completions: {create}}, responses: {create: vi.fn(async function* () {})}}
    }
    const create = vi.fn(async function* () {})
    return {responses: {create}, chat: {completions: {create: vi.fn(async function* () {})}}}
}

function makeAdapter(apiStyle: ApiStyle, baseUrl?: string) {
    const client = makeMockClient(apiStyle)
    const adapter = new OpenAIAdapter(
        {provider: 'openai', model: 'gpt-5.5', apiKey: 'sk-test', apiStyle, baseUrl} as any,
        client as any,
    )
    return {adapter, client}
}

async function runChat(adapter: OpenAIAdapter, thinkingEffort: string) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of adapter.chat({messages: [{role: 'user', content: 'hi'}], thinkingEffort} as any)) {
        // 消费全部 chunk
    }
}

describe('OpenAIAdapter thinkingEffort 端点来源策略', () => {
    let logSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
        logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    })
    afterEach(() => {
        logSpy.mockRestore()
    })

    describe('官方端点', () => {
        const baseUrls: (string | undefined)[] = [undefined, 'https://api.openai.com/v1']

        for (const baseUrl of baseUrls) {
            it(`chat 路径：baseUrl=${baseUrl ?? '(空)'} xhigh/max 原样透传，auto → medium`, async () => {
                for (const effort of ['xhigh', 'max']) {
                    const {adapter, client} = makeAdapter('chat', baseUrl)
                    await runChat(adapter, effort)
                    const args = (firstCall(client.chat.completions.create))
                    expect(args.reasoning_effort).toBe(effort)
                    expect(logSpy).not.toHaveBeenCalled()
                }
                {
                    const {adapter, client} = makeAdapter('chat', baseUrl)
                    await runChat(adapter, 'auto')
                    const args = (firstCall(client.chat.completions.create))
                    expect(args.reasoning_effort).toBe('medium')
                    expect(logSpy).toHaveBeenCalledWith('[OpenAIAdapter] thinkingEffort 映射',
                        expect.objectContaining({model: 'gpt-5.5', original: 'auto', sent: 'medium'}))
                }
            })

            it(`chatResponses 路径：baseUrl=${baseUrl ?? '(空)'} xhigh/max 原样透传，auto → medium`, async () => {
                for (const effort of ['xhigh', 'max']) {
                    const {adapter, client} = makeAdapter('responses', baseUrl)
                    await runChat(adapter, effort)
                    const args = (firstCall(client.responses.create))
                    expect(args.reasoning).toEqual({effort})
                    expect(logSpy).not.toHaveBeenCalled()
                }
                {
                    const {adapter, client} = makeAdapter('responses', baseUrl)
                    await runChat(adapter, 'auto')
                    const args = (firstCall(client.responses.create))
                    expect(args.reasoning).toEqual({effort: 'medium'})
                }
            })
        }

        it('其他档位不受影响（low/medium/high 原样透传）', async () => {
            for (const effort of ['low', 'medium', 'high']) {
                const {adapter, client} = makeAdapter('chat')
                await runChat(adapter, effort)
                expect((firstCall(client.chat.completions.create)).reasoning_effort).toBe(effort)
                expect(logSpy).not.toHaveBeenCalled()
            }
        })
    })

    describe('第三方兼容网关', () => {
        const baseUrl = 'https://openrouter.ai/api/v1'

        it('chat 路径：auto/xhigh/max 全部降级为 high 并记录日志', async () => {
            for (const effort of ['auto', 'xhigh', 'max']) {
                logSpy.mockClear()
                const {adapter, client} = makeAdapter('chat', baseUrl)
                await runChat(adapter, effort)
                const args = (firstCall(client.chat.completions.create))
                expect(args.reasoning_effort).toBe('high')
                expect(logSpy).toHaveBeenCalledWith('[OpenAIAdapter] thinkingEffort 映射',
                    expect.objectContaining({model: 'gpt-5.5', original: effort, sent: 'high'}))
            }
        })

        it('chatResponses 路径：auto/xhigh/max 全部降级为 high 并记录日志', async () => {
            for (const effort of ['auto', 'xhigh', 'max']) {
                logSpy.mockClear()
                const {adapter, client} = makeAdapter('responses', baseUrl)
                await runChat(adapter, effort)
                const args = (firstCall(client.responses.create))
                expect(args.reasoning).toEqual({effort: 'high'})
                expect(logSpy).toHaveBeenCalledWith('[OpenAIAdapter] thinkingEffort 映射',
                    expect.objectContaining({model: 'gpt-5.5', original: effort, sent: 'high'}))
            }
        })
    })

    it('OllamaAdapter（继承）走兼容降级路径：auto/xhigh/max → high', async () => {
        const client = makeMockClient('chat')
        const adapter = new OllamaAdapter(
            {provider: 'ollama', model: 'qwen3', apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1'} as any,
            client as any,
        )
        for (const effort of ['auto', 'xhigh', 'max']) {
            await runChat(adapter, effort)
            const args = (lastCall(client.chat.completions.create))
            expect(args.reasoning_effort).toBe('high')
        }
    })
})
