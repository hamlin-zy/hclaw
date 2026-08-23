import {describe, expect, it, vi} from 'vitest'
import {OpenAIAdapter} from '../../../../src/main/agent/model/openaiAdapter'
import type {ChatMessage, ChatParams, ToolDefinition} from '../../../../src/main/agent/model/types'

/** 构造 mock OpenAI client：responses.create 返回可控异步迭代流 */
function makeMockClient(streamEvents: any[]): any {
    const create = vi.fn(async function* () {
        for (const ev of streamEvents) yield ev
    })
    return {responses: {create}, chat: {completions: {create: vi.fn(async function* () {})}}}
}

function makeAdapter(client: any, apiStyle: 'chat' | 'responses' = 'responses') {
    return new OpenAIAdapter({provider: 'openai', model: 'gpt-5', apiKey: 'sk-test', apiStyle} as any, client)
}

const TOOLS: ToolDefinition[] = [
    {name: 'bash', description: 'Run shell', inputSchema: {type: 'object', properties: {cmd: {type: 'string'}}, required: ['cmd']}},
]

describe('OpenAIAdapter Responses API 路径', () => {
    it('apiStyle=chat 时仍走 chat.completions.create', async () => {
        const client = makeMockClient([])
        const adapter = makeAdapter(client, 'chat')
        const gen = adapter.chat({messages: [{role: 'user', content: 'hi'}], systemPrompt: 'sys'} as ChatParams)
        await gen.next()
        expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
        expect(client.responses.create).not.toHaveBeenCalled()
    })

    it('apiStyle=responses 时走 responses.create 且 input/instructions 正确转换', async () => {
        const client = makeMockClient([])
        const adapter = makeAdapter(client, 'responses')
        const gen = adapter.chat({
            messages: [
                {role: 'user', content: 'hello'},
                {role: 'assistant', content: 'world', toolCalls: [{id: 'tc1', name: 'bash', arguments: {cmd: 'ls'}}]},
                {role: 'tool', toolCallId: 'tc1', content: 'ok', toolResult: 'ok'},
            ],
            systemPrompt: '你是助手',
            tools: TOOLS,
            maxTokens: 1000,
        } as ChatParams)
        await gen.next()
        expect(client.responses.create).toHaveBeenCalledTimes(1)
        const callArgs = client.responses.create.mock.calls[0][0]
        expect(callArgs.model).toBe('gpt-5')
        expect(callArgs.instructions).toBe('你是助手')
        expect(callArgs.max_output_tokens).toBe(1000)
        expect(callArgs.input[0]).toEqual({role: 'user', content: 'hello'})
        // assistant 工具调用 → function_call；tool 结果 → function_call_output
        const fnCall = callArgs.input.find((m: any) => m.type === 'function_call')
        expect(fnCall).toBeDefined()
        expect(fnCall.call_id).toBe('tc1')
        expect(fnCall.name).toBe('bash')
        const fnOutput = callArgs.input.find((m: any) => m.type === 'function_call_output')
        expect(fnOutput).toBeDefined()
        expect(fnOutput.output).toBe('ok')
        expect(callArgs.tools[0]).toMatchObject({type: 'function', name: 'bash'})
    })

    it('流式事件转换：output_text.delta → text，completed → done', async () => {
        const client = makeMockClient([
            {type: 'response.output_text.delta', delta: '你'},
            {type: 'response.output_text.delta', delta: '好'},
            {type: 'response.completed', response: {}},
        ])
        const adapter = makeAdapter(client, 'responses')
        const chunks: any[] = []
        for await (const c of adapter.chat({messages: [{role: 'user', content: 'hi'}]} as ChatParams)) chunks.push(c)
        expect(chunks.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('你好')
        expect(chunks.some(c => c.type === 'done')).toBe(true)
    })

    it('function_call_arguments.delta 累积为 tool_use；completed 带 usage 时提取', async () => {
        const client = makeMockClient([
            {type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"cmd": "l'},
            {type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: 's"}'},
            {type: 'response.completed', response: {
                usage: {input_tokens: 120, output_tokens: 30, total_tokens: 150},
            }},
        ])
        const adapter = makeAdapter(client, 'responses')
        const chunks: any[] = []
        for await (const c of adapter.chat({messages: [{role: 'user', content: 'hi'}]} as ChatParams)) chunks.push(c)
        const toolUse = chunks.find(c => c.type === 'tool_use')
        expect(toolUse).toBeDefined()
        expect(toolUse.name).toBe('fc1') // item_id 作为工具名占位；name 由输出项补充（见实现）
        expect(toolUse.input.cmd).toBe('ls')
        const usage = chunks.find(c => c.type === 'usage')
        expect(usage).toBeDefined()
        expect(usage.inputTokens).toBe(120)
        expect(usage.outputTokens).toBe(30)
    })

    it('reasoning: {effort} 映射（Responses 专用参数）', async () => {
        const client = makeMockClient([])
        const adapter = makeAdapter(client, 'responses')
        const gen = adapter.chat({messages: [{role: 'user', content: 'hi'}], thinkingEffort: 'high'} as ChatParams)
        await gen.next()
        const callArgs = client.responses.create.mock.calls[0][0]
        expect(callArgs.reasoning).toEqual({effort: 'high'})
    })

    it('convertMessagesForTestResponses 输出 Responses input 结构', () => {
        const client = makeMockClient([])
        const adapter = makeAdapter(client, 'responses')
        const input = adapter.convertMessagesForTestResponses([{role: 'user', content: 'hi'}])
        expect(input).toEqual([{role: 'user', content: 'hi'}])
    })

    it('done.stopReason 契约：流含工具调用时 = tool_use', async () => {
        const client = makeMockClient([
            {type: 'response.output_item.added', item: {id: 'fc1', type: 'function_call', name: 'bash'}},
            {type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"cmd": "ls"}'},
            {type: 'response.completed', response: {
                status: 'completed',
                output: [{type: 'function_call', id: 'fc1', name: 'bash'}],
            }},
        ])
        const adapter = makeAdapter(client, 'responses')
        const chunks: any[] = []
        for await (const c of adapter.chat({messages: [{role: 'user', content: 'hi'}]} as ChatParams)) chunks.push(c)
        const done = chunks.find(c => c.type === 'done')
        expect(done).toBeDefined()
        expect(done.stopReason).toBe('tool_use')
    })

    it('done.stopReason 契约：completed 响应含 function_call 输出项（无增量事件）也 = tool_use', async () => {
        const client = makeMockClient([
            {type: 'response.completed', response: {
                status: 'completed',
                output: [{type: 'function_call', id: 'fc1', name: 'bash'}],
            }},
        ])
        const adapter = makeAdapter(client, 'responses')
        const chunks: any[] = []
        for await (const c of adapter.chat({messages: [{role: 'user', content: 'hi'}]} as ChatParams)) chunks.push(c)
        const done = chunks.find(c => c.type === 'done')
        expect(done).toBeDefined()
        expect(done.stopReason).toBe('tool_use')
    })

    it('done.stopReason 契约：流无工具调用时 = end_turn', async () => {
        const client = makeMockClient([
            {type: 'response.output_text.delta', delta: '你好'},
            {type: 'response.completed', response: {status: 'completed', output: []}},
        ])
        const adapter = makeAdapter(client, 'responses')
        const chunks: any[] = []
        for await (const c of adapter.chat({messages: [{role: 'user', content: 'hi'}]} as ChatParams)) chunks.push(c)
        const done = chunks.find(c => c.type === 'done')
        expect(done).toBeDefined()
        expect(done.stopReason).toBe('end_turn')
    })
})

describe('Responses API 图片块（input_image 转换）', () => {
  function adapterForInput(): OpenAIAdapter {
    const client = makeMockClient([])
    return new OpenAIAdapter({provider: 'openai', model: 'gpt-5', apiKey: 'sk-test', apiStyle: 'responses'} as any, client)
  }

  it('image_url (data:URI) → input_image 扁平字符串 + detail', () => {
    const adapter = adapterForInput() as any
    const input = adapter.convertMessagesForTestResponses([
      {role: 'user', content: [
        {type: 'text', text: '描述图'},
        {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA', detail: 'low'}},
      ]},
    ])
    const userItem = input[0]
    expect(userItem.content[0]).toEqual({type: 'input_text', text: '描述图'})
    expect(userItem.content[1]).toEqual({type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'low'})
  })

  it('image_url (网络 URL) → input_image（扁平字符串）', () => {
    const adapter = adapterForInput() as any
    const input = adapter.convertMessagesForTestResponses([
      {role: 'user', content: [{type: 'image_url', image_url: {url: 'https://example.com/a.png'}}]},
    ])
    expect(input[0].content[0]).toEqual({type: 'input_image', image_url: 'https://example.com/a.png'})
  })

  it('image_url 无 detail → detail 缺省（不添加）', () => {
    const adapter = adapterForInput() as any
    const input = adapter.convertMessagesForTestResponses([
      {role: 'user', content: [{type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}}]},
    ])
    const img = input[0].content[0]
    expect(img.type).toBe('input_image')
    expect(img.detail).toBeUndefined()
  })

  it('chat 路径回归：convertUserContent 仍输出嵌套对象结构', () => {
    const client = makeMockClient([])
    const adapter = new OpenAIAdapter({provider: 'openai', model: 'gpt-5', apiKey: 'sk-test', apiStyle: 'chat'} as any, client) as any
    const msgs = adapter.convertMessagesForTest([
      {role: 'user', content: [{type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}}]},
    ])
    const content = msgs[0].content
    expect(content[0].image_url).toBeInstanceOf(Object)
    expect(content[0].image_url.url).toBe('data:image/png;base64,AAA')
  })
})
