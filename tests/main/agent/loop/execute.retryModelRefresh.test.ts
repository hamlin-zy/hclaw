import {describe, expect, it, vi, afterEach} from 'vitest'
import {executeLlmCallWithRetry, type ExecuteLlmCallParams} from '../../../../src/main/agent/loop/execute'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import type {ChatMessage, ModelAdapter, StreamChunk} from '../../../../src/main/agent/model/types'
import type {ToolDefinitionForLLM} from '../../../../src/main/agent/tools/types'

// ★ mock selectModelForTurn：重试期间用户切换了模型（override → openai/gpt-5），
//   executeLlmCallWithRetry 应在 attempt ≥ 2 时重新解析并用新配置重试。
//   注意：真实 selectModelForTurn 是同步 generator（yield* 消费），mock 必须返回生成器。
vi.mock('../../../../src/main/agent/loop/setup', () => ({
    defaultRoleForTrace: (traceContext?: string) => (traceContext === 'subAgent' ? 'lightweight' : 'primary'),
    selectModelForTurn: vi.fn(function* () {
        return {
            modelConfig: {provider: 'openai', model: 'gpt-5', apiKey: 'sk-new'} as never,
            schemeId: 'scheme-1',
            schemeName: 'test',
            suggestedRole: 'primary' as const,
            directModel: true,
        }
    }),
}))

import {selectModelForTurn} from '../../../../src/main/agent/loop/setup'

describe('executeLlmCallWithRetry 重试前重新解析模型配置（倒计时期间用户切换模型）', () => {
    afterEach(() => vi.restoreAllMocks())

    function makeDef(name: string): ToolDefinitionForLLM {
        return {name, description: `${name} desc`, inputSchema: {type: 'object', properties: {}}}
    }

    /** attempt 1 流：旧模型（deepseek-v3）抛错 → 触发重试 */
    async function* errStream(): AsyncGenerator<StreamChunk> {
        throw new Error('500 server error')
    }

    /** attempt 2 流：新模型（gpt-5）正常响应 */
    async function* okStream(): AsyncGenerator<StreamChunk> {
        yield {type: 'text', content: 'ok'}
        yield {type: 'usage', inputTokens: 1, outputTokens: 2}
        yield {type: 'done', stopReason: 'end_turn'}
    }

    function buildCtx(): {ctx: ExecuteLlmCallParams; llmCaller: {getAdapter: ReturnType<typeof vi.fn>}} {
        const chatErr = vi.fn().mockImplementation(() => errStream())
        const chatOk = vi.fn().mockImplementation(() => okStream())
        const adapterV3 = {
            chat: chatErr,
            getModelInfo: () => ({maxContextTokens: 128_000}),
            invalidateConvertCache: vi.fn(),
        } as unknown as ModelAdapter
        const adapterGpt5 = {
            chat: chatOk,
            getModelInfo: () => ({maxContextTokens: 128_000}),
            invalidateConvertCache: vi.fn(),
        } as unknown as ModelAdapter

        const llmCaller = {
            getAdapter: vi.fn()
                .mockResolvedValueOnce({
                    adapter: adapterV3,
                    providerType: 'deepseek',
                    modelId: 'deepseek-v3',
                    configSource: 'scheme-param',
                    schemeName: null,
                })
                .mockResolvedValueOnce({
                    adapter: adapterGpt5,
                    providerType: 'openai',
                    modelId: 'gpt-5',
                    configSource: 'direct',
                    schemeName: null,
                }),
        }

        const ctx: ExecuteLlmCallParams = {
            llmCaller: llmCaller as never,
            state: {messages: [] as ChatMessage[]} as never,
            systemPrompt: 'sys',
            availableToolDefinitions: [makeDef('file_read')],
            preCapabilityToolDefinitions: [makeDef('file_read')],
            // 旧模型配置（turn 开始时解析）
            modelConfig: {provider: 'deepseek', model: 'deepseek-v3', apiKey: 'sk-old'} as never,
            workModeRole: 'primary',
            schemeName: null,
            getSettings: () => ({
                agent: {retryCount: 2, initialRetryDelay: 1, maxRetryDelay: 5, llmTimeout: 5000},
                model: {defaultMaxTokens: 4096, defaultTemperature: 0},
            }) as never,
            params: {
                abortSignal: undefined,
                requestConfirmation: undefined,
                sessionId: 'conv-1',
                schemeConfig: undefined,
            } as never,
                  turns: 1,
            preprocessCache: new PreprocessCache(),
            directModel: false,
        }
        return {ctx, llmCaller}
    }

    it('attempt 2 前重新解析配置 → getAdapter 收到新模型（provider/model/directModel 均更新）', async () => {
        const {ctx, llmCaller} = buildCtx()
        const gen = executeLlmCallWithRetry(ctx)

        // 驱动整个生成器（含 retryBackoff 等待）直到完成
        let done: IteratorResult<unknown, unknown>
        do {
            done = await gen.next()
        } while (!done.done)

        // 1. 重试时重新解析了模型配置
        expect(selectModelForTurn).toHaveBeenCalledTimes(1)
        expect(selectModelForTurn).toHaveBeenCalledWith(undefined, 'conv-1', undefined, 'primary')

        // 2. getAdapter 被调用 2 次，第二次收到新模型 + directModel=true + 新角色
        expect(llmCaller.getAdapter).toHaveBeenCalledTimes(2)
        const secondCall = llmCaller.getAdapter.mock.calls[1]
        expect(secondCall[1]).toMatchObject({provider: 'openai', model: 'gpt-5', apiKey: 'sk-new'})
        expect(secondCall[4]).toBe(true) // directModel
        expect(secondCall[5]).toBe('primary') // preferredRole（重解析后的 suggestedRole）

        // 3. 两次 chat 均被消费（旧模型失败一次 / 新模型成功一次）
        expect(done.value).toMatchObject({currentProvider: 'openai', currentModel: 'gpt-5'})
    })

    it('配置未变化时也重新解析（保留原配置，不抛错且仍重试成功）', async () => {
        // 覆盖 mock：重解析返回与旧配置一致（用户未切换）
        vi.mocked(selectModelForTurn).mockImplementationOnce(function* () {
            return {
                modelConfig: {provider: 'deepseek', model: 'deepseek-v3', apiKey: 'sk-old'} as never,
                schemeId: 'scheme-1',
                schemeName: 'test',
                suggestedRole: 'primary',
                directModel: false,
            }
        })
        const {ctx, llmCaller} = buildCtx()
        // getAdapter 两次均返回旧模型配置（与"未切换"场景自洽，避免 mismatch 噪音）；
        // chat 第一次失败触发重试、第二次成功
        const adapterV3Again = {
            chat: vi.fn()
                .mockImplementationOnce(() => errStream())
                .mockImplementationOnce(() => okStream()),
            getModelInfo: () => ({maxContextTokens: 128_000}),
            invalidateConvertCache: vi.fn(),
        } as unknown as ModelAdapter
        vi.mocked(llmCaller.getAdapter)
            .mockReset()
            .mockResolvedValueOnce({adapter: adapterV3Again, providerType: 'deepseek', modelId: 'deepseek-v3', configSource: 'scheme-param', schemeName: null})
            .mockResolvedValueOnce({adapter: adapterV3Again, providerType: 'deepseek', modelId: 'deepseek-v3', configSource: 'scheme-param', schemeName: null})

        const gen = executeLlmCallWithRetry(ctx)
        let done: IteratorResult<unknown, unknown>
        do {
            done = await gen.next()
        } while (!done.done)

        expect(llmCaller.getAdapter).toHaveBeenCalledTimes(2)
        const secondCall = llmCaller.getAdapter.mock.calls[1]
        expect(secondCall[1]).toMatchObject({provider: 'deepseek', model: 'deepseek-v3'})
        expect(secondCall[4]).toBe(false)
    })
})
