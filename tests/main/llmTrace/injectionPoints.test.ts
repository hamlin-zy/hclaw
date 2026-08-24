// tests/main/llmTrace/injectionPoints.test.ts
/**
 * Task 4 探针测试：四处 SDK 客户端构造必须常驻注入 recordingFetch。
 *
 * 策略：vi.doMock 替换各 SDK 模块为捕获构造参数的桩类，
 * 再 dynamic import 被测模块（保证 doMock 生效），
 * 断言构造参数中的 fetch / fetchFn 与 recordingFetch 同一引用。
 *
 * injectedClient 注入分支（测试模式）不在本测试覆盖范围，行为保持不变。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

/** 各桩类捕获到的构造参数 */
const captured: Record<string, any> = {}

function clearCaptured(): void {
    for (const k of Object.keys(captured)) delete captured[k]
}

beforeEach(() => {
    clearCaptured()
})

afterEach(() => {
    vi.doUnmock('openai')
    vi.doUnmock('@anthropic-ai/sdk')
    vi.doUnmock('@google/generative-ai')
    vi.resetModules()
})

// ─── SDK 桩工厂 ────────────────────────────────────────────

/** OpenAI 兼容 SDK 桩：捕获构造参数 */
function stubOpenAI(slot: string): Record<string, unknown> {
    return {
        default: class OpenAIStub {
            constructor(opts: any) {
                captured[slot] = opts
            }
        },
    }
}

/** Anthropic SDK 桩：捕获构造参数 */
function stubAnthropic(slot: string): Record<string, unknown> {
    return {
        default: class AnthropicStub {
            constructor(opts: any) {
                captured[slot] = opts
            }
        },
    }
}

// ─── 1. openaiAdapter ─────────────────────────────────────

describe('SDK 注入点：openaiAdapter', () => {
    it('非注入路径 new OpenAI 传入 fetch: recordingFetch', async () => {
        vi.doMock('openai', () => stubOpenAI('openai'))
        const {recordingFetch} = await import('../../../src/main/utils/llmTraceRecorder')
        const {OpenAIAdapter} = await import('../../../src/main/agent/model/openaiAdapter')
        new OpenAIAdapter({apiKey: 'k', model: 'gpt-4o'} as any)
        expect(captured.openai).toBeDefined()
        expect(captured.openai.fetch).toBe(recordingFetch)
    })

    it('injectedClient 注入路径不经过 new OpenAI（行为保持不变）', async () => {
        vi.doMock('openai', () => stubOpenAI('openai-injected'))
        const {OpenAIAdapter} = await import('../../../src/main/agent/model/openaiAdapter')
        const sentinel = {mark: 'injected-client'}
        new OpenAIAdapter({apiKey: 'k', model: 'gpt-4o'} as any, sentinel as any)
        expect(captured['openai-injected']).toBeUndefined()
    })
})

// ─── 2. anthropicAdapter ──────────────────────────────────

describe('SDK 注入点：anthropicAdapter', () => {
    it('非注入路径 new Anthropic 传入 fetch: recordingFetch', async () => {
        vi.doMock('@anthropic-ai/sdk', () => stubAnthropic('anthropic'))
        const {recordingFetch} = await import('../../../src/main/utils/llmTraceRecorder')
        const {AnthropicAdapter} = await import('../../../src/main/agent/model/anthropicAdapter')
        new AnthropicAdapter({apiKey: 'k', model: 'claude-sonnet-4-20250514'} as any)
        expect(captured.anthropic).toBeDefined()
        expect(captured.anthropic.fetch).toBe(recordingFetch)
    })

    it('injectedClient 注入路径不经过 new Anthropic（行为保持不变）', async () => {
        vi.doMock('@anthropic-ai/sdk', () => stubAnthropic('anthropic-injected'))
        const {AnthropicAdapter} = await import('../../../src/main/agent/model/anthropicAdapter')
        const sentinel = {mark: 'injected-client'}
        new AnthropicAdapter({apiKey: '', model: 'claude-sonnet-4-20250514'} as any, sentinel as any)
        expect(captured['anthropic-injected']).toBeUndefined()
    })
})

// ─── 3. modelSchemeManager ────────────────────────────────

describe('SDK 注入点：modelSchemeManager', () => {
    const PROVIDER_BASE = {
        id: 'p1',
        name: 'probe',
        models: [],
    }

    it('createOpenAIClient 传入 fetch: recordingFetch', async () => {
        vi.doMock('openai', () => stubOpenAI('msc-openai'))
        const {recordingFetch} = await import('../../../src/main/utils/llmTraceRecorder')
        const mgr = await import('../../../src/main/agent/model/modelSchemeManager')
        mgr.createOpenAIClient({...PROVIDER_BASE, type: 'openai', apiKey: 'k', baseUrl: ''} as any)
        expect(captured['msc-openai'].fetch).toBe(recordingFetch)
    })

    it('createOllamaClient 传入 fetch: recordingFetch', async () => {
        vi.doMock('openai', () => stubOpenAI('msc-ollama'))
        const {recordingFetch} = await import('../../../src/main/utils/llmTraceRecorder')
        const mgr = await import('../../../src/main/agent/model/modelSchemeManager')
        mgr.createOllamaClient({...PROVIDER_BASE, type: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1'} as any)
        expect(captured['msc-ollama'].fetch).toBe(recordingFetch)
    })

    it('createAnthropicClient 传入 fetch: recordingFetch', async () => {
        vi.doMock('@anthropic-ai/sdk', () => stubAnthropic('msc-anthropic'))
        const {recordingFetch} = await import('../../../src/main/utils/llmTraceRecorder')
        const mgr = await import('../../../src/main/agent/model/modelSchemeManager')
        mgr.createAnthropicClient({...PROVIDER_BASE, type: 'anthropic', apiKey: 'k', baseUrl: ''} as any)
        expect(captured['msc-anthropic'].fetch).toBe(recordingFetch)
    })
})

// ─── 4. googleAdapter（API Key 模式，经公开 chat() 路径验证）──

describe('SDK 注入点：googleAdapter', () => {
    it('非 OAuth 路径 getGenerativeModel 补 fetchFn: recordingFetch', async () => {
        vi.doMock('@google/generative-ai', () => ({
            GoogleGenerativeAI: class GoogleGenStub {
                constructor(public _apiKey: string) {}
                getGenerativeModel(_opts: any, requestOptions?: any) {
                    captured.google = requestOptions
                    return {
                        // sendMessageStream 抛错即结束流：本测试只关心 getGenerativeModel 参数
                        startChat: () => ({
                            sendMessageStream: async () => {
                                throw new Error('probe-stop')
                            },
                        }),
                    }
                }
            },
        }))
        const {recordingFetch} = await import('../../../src/main/utils/llmTraceRecorder')
        const {GoogleAdapter} = await import('../../../src/main/agent/model/googleAdapter')
        const adapter = new GoogleAdapter({apiKey: 'k', model: 'gemini-2.5-flash'} as any)
        // 消费生成器以触发 getGenerativeModel 调用；错误 chunk 正常终止迭代
        for await (const chunk of adapter.chat({messages: [{role: 'user', content: 'hi'}]} as any)) {
            void chunk
        }
        expect(captured.google).toBeDefined()
        expect(captured.google.fetchFn).toBe(recordingFetch)
    })
})
