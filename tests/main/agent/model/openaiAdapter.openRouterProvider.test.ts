/**
 * OpenAIAdapter OpenRouter 固定服务商注入测试
 *
 * 语义（OpenRouter 官方 Chat Completions `provider` 对象）：
 * - order: string[]              服务商 slug 优先级
 * - allow_fallbacks: boolean     默认 true；false = 主服务商不可用即失败
 * 产品决策「单选 + 锁死」→ { order: [slug], allow_fallbacks: false }
 *
 * 注入条件：端点判定为 OpenRouter（isOpenRouterEndpoint）且 slug 非空；
 * 其余情况 body 必须完全不变（不出现 provider 字段）。
 */
import {describe, expect, it, vi} from 'vitest'
import {OpenAIAdapter} from '../../../../src/main/agent/model/openaiAdapter'

type ApiStyle = 'chat' | 'responses'

/** 桩客户端：vi.fn 捕获每次 create 的首参（即请求 body） */
function makeMockClient(apiStyle: ApiStyle, baseURL?: string) {
    if (apiStyle === 'chat') {
        const create = vi.fn(async function* () { /* 空流 */ })
        return {baseURL, chat: {completions: {create}}, responses: {create: vi.fn(async function* () {})}}
    }
    const create = vi.fn(async function* () { /* 空流 */ })
    return {baseURL, responses: {create}, chat: {completions: {create: vi.fn(async function* () {})}}}
}

function makeAdapter(opts: { apiStyle: ApiStyle; baseUrl?: string; clientBaseURL?: string }) {
    const client = makeMockClient(opts.apiStyle, opts.clientBaseURL)
    const adapter = new OpenAIAdapter(
        {provider: 'openai', model: 'deepseek-v4-pro', apiKey: 'sk-test', apiStyle: opts.apiStyle, baseUrl: opts.baseUrl} as any,
        client as any,
    )
    return {adapter, client}
}

function captureParams(client: any, apiStyle: ApiStyle): any {
    return apiStyle === 'chat'
        ? client.chat.completions.create.mock.calls[0]?.[0]
        : client.responses.create.mock.calls[0]?.[0]
}

async function runChat(adapter: OpenAIAdapter, openRouterProvider?: string): Promise<void> {
    const params: any = {messages: [{role: 'user', content: 'hi'}]}
    if (openRouterProvider !== undefined) params.openRouterProvider = openRouterProvider
    for await (const chunk of adapter.chat(params as any)) void chunk
}

const apiStyles: ApiStyle[] = ['chat', 'responses']

describe('OpenAIAdapter · OpenRouter 固定服务商注入', () => {
    for (const apiStyle of apiStyles) {
        it(`${apiStyle} 路径：OpenRouter 端点 + slug → provider.order=[slug] 且 allow_fallbacks=false`, async () => {
            const {adapter, client} = makeAdapter({apiStyle, baseUrl: 'https://openrouter.ai/api/v1'})
            await runChat(adapter, 'deepinfra')
            const body = captureParams(client, apiStyle)
            expect(body.provider).toEqual({order: ['deepinfra'], allow_fallbacks: false})
        })
    }

    it('非 OpenRouter 端点（api.openai.com）+ slug → body 无 provider 字段', async () => {
        for (const apiStyle of apiStyles) {
            const {adapter, client} = makeAdapter({apiStyle, baseUrl: 'https://api.openai.com/v1'})
            await runChat(adapter, 'deepinfra')
            expect(captureParams(client, apiStyle).provider).toBeUndefined()
        }
    })

    it('OpenRouter 端点 + slug 为空串/undefined → body 无 provider 字段', async () => {
        for (const apiStyle of apiStyles) {
            for (const slug of ['', '   ', undefined]) {
                const {adapter, client} = makeAdapter({apiStyle, baseUrl: 'https://openrouter.ai/api/v1'})
                await runChat(adapter, slug)
                expect(captureParams(client, apiStyle).provider).toBeUndefined()
            }
        }
    })

    it('回归：config.baseUrl 为空串但 client.baseURL 指向 OpenRouter 时仍注入', async () => {
        // 全局方案路径（model/index.ts）硬编码 config.baseUrl = ''，端点信息只存在于注入的 client 上
        for (const apiStyle of apiStyles) {
            const {adapter, client} = makeAdapter({
                apiStyle,
                baseUrl: '',
                clientBaseURL: 'https://openrouter.ai/api/v1',
            })
            await runChat(adapter, 'deepinfra/turbo')
            expect(captureParams(client, apiStyle).provider).toEqual({
                order: ['deepinfra/turbo'],
                allow_fallbacks: false,
            })
        }
    })

    it('slug 两侧空白被 trim 后注入', async () => {
        const {adapter, client} = makeAdapter({apiStyle: 'chat', baseUrl: 'https://openrouter.ai/api/v1'})
        await runChat(adapter, '  deepinfra  ')
        expect(captureParams(client, 'chat').provider).toEqual({order: ['deepinfra'], allow_fallbacks: false})
    })
})
