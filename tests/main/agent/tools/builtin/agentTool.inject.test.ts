/**
 * agentTool — 运行中子会话注入消息（集成）
 *
 * 覆盖：
 * 1. injectChildMessage：子会话运行中入队（true + 引用同一队列）；未运行 false
 * 2. execute 事件流中 user_message_injected → 累积器轮换（两条不同 id 的
 *    assistant 消息，旧消息带 endedAt）
 * 3. 注入事件不被吞：user_message_injected 仍经 sendChildAgentEvent 转发
 *    （渲染端依赖它清空 streamingMessageId）；注入后的 text 携带新 messageId
 * 4. finally 兜底：运行结束后注册表清理（注入返回 false，不泄漏）
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// parentPort 打桩：sendToRenderer 走 Worker 分支，事件可被断言（主进程 window 分支在测试中不可用）
vi.mock('worker_threads', () => ({parentPort: {postMessage: vi.fn()}}))

vi.mock('@/main/agent/loop', () => ({agentLoop: vi.fn()}))
vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: vi.fn(() => null),
        getProviders: vi.fn(() => []),
        getConfig: vi.fn(() => ({workingDir: ''})),
        setOverride: vi.fn(),
    },
}))
vi.mock('@/main/agent/agentRegistry', () => ({
    agentRegistry: {
        find: vi.fn((name: string) => (name === 'General Agent' ? {id: 'general', name: 'General Agent', enabled: true} : undefined)),
        getEnabled: vi.fn(() => []),
    },
}))
vi.mock('@/main/agent/agentTemplateConverter', () => ({
    agentTemplateToDefinition: vi.fn(() => ({
        source: 'user', agentType: 'General Agent', whenToUse: '', description: '',
        systemPromptTemplate: '', tools: '*', permissionMode: 'auto',
    })),
}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {getJson: vi.fn(() => undefined)},
}))
vi.mock('@/main/repositories/sqlite/llmUsageRepository', () => ({
    llmUsageRepo: {record: vi.fn()},
}))
vi.mock('@/main/repositories', () => ({
    createConversationRepository: vi.fn(),
    createPermissionRepository: vi.fn(() => ({getAll: vi.fn(() => []), create: vi.fn(), update: vi.fn(), remove: vi.fn()})),
}))

import {agentTool, injectChildMessage, setAgentToolConfig} from '@/main/agent/tools/builtin/agentTool'
import {agentLoop} from '@/main/agent/loop'
import {runtimeConfigManager as runtimeCfg} from '@/main/agent/runtimeConfigManager'
import {createConversationRepository} from '@/main/repositories'
import {parentPort} from 'worker_threads'
import type {AgentStreamEvent} from '@/main/agent/stream'
import type {ChatMessage} from '@/main/agent/model/types'

// ─── 测试基建 ────────────────────────────────────────────

const PROVIDERS = [
    {id: 'p1', name: '主力服务商', type: 'openai', enabled: true, baseUrl: '', models: [{id: 'm1', name: '主力模型', enabled: true}]},
] as any

function mockRepo() {
    const written: Array<{convId: string; messages: any[]}> = []
    vi.mocked(createConversationRepository).mockReturnValue({
        readMeta: vi.fn(() => null),
        create: vi.fn(),
        writeMessages: (convId: string, messages: any[]) => {
            written.push({convId, messages})
            return true
        },
    } as any)
    return written
}

/** 可暂停的 agentLoop mock：yield 事件前等待 gate，模拟真实异步流 */
function mockAgentLoopStream(events: AgentStreamEvent[]) {
    vi.mocked(agentLoop).mockImplementation((() => {
        let i = 0
        return {
            [Symbol.asyncIterator]() {
                return {
                    next: async () => {
                        await gate.promise
                        return i < events.length ? {value: events[i++], done: false} : {value: undefined, done: true}
                    },
                }
            },
        } as any
    }) as any)
    const gate = {promise: null! as Promise<void>, resolve: null! as () => void}
    gate.promise = new Promise<void>(r => { gate.resolve = r })
    return gate
}

const childAgentEvents = () =>
    (parentPort as unknown as {postMessage: ReturnType<typeof vi.fn>}).postMessage.mock.calls
        .map(c => c[0] as {type: string; event?: AgentStreamEvent})
        .filter(m => m.type === 'child_agent_event')
        .map(m => m.event!)

function makeContext() {
    const sent: any[] = []
    return {
        toolCallId: 'tc-parent-1',
        conversationId: undefined as unknown as string,
        abortSignal: undefined as unknown as AbortSignal,
        sendMessage: (e: any) => { sent.push(e) },
        sent,
    }
}

async function runAgentTool(events: AgentStreamEvent[]) {
    const written = mockRepo()
    const gate = mockAgentLoopStream(events)
    const ctx = makeContext()
    const pending = vi.mocked(agentLoop).mock.calls.length
    const resultP = agentTool.execute({task: '做点事', agent: 'General Agent', modelRole: 'primary'} as any, ctx as any)

    // 等待 agentLoop 被调用并捕获其参数（首个 next() 前生成器体不执行，
    // 但 agentTool 在调用 agentLoop 前已同步完成注册表注册与 args 构建）
    await vi.waitFor(() => {
        expect(vi.mocked(agentLoop).mock.calls.length).toBe(pending + 1)
    })
    const loopArgs = vi.mocked(agentLoop).mock.calls[pending][0] as {
        sessionId: string
        pendingInjectedMessages: ChatMessage[]
    }
    // 首个事件已就绪：放行事件流
    gate.resolve()
    const result = await resultP
    return {result, written, ctx, loopArgs}
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runtimeCfg.getProviders).mockReturnValue(PROVIDERS)
    vi.mocked(runtimeCfg.getScheme).mockReturnValue({roles: [{role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'}]} as any)
    setAgentToolConfig()
})

const text = (content: string): AgentStreamEvent => ({type: 'text', content})
const injected: AgentStreamEvent = {type: 'user_message_injected'} as any
const done = (reason = 'completed'): AgentStreamEvent => ({type: 'done', reason}) as any

// ─── injectChildMessage 注册表语义 ────────────────────────

describe('injectChildMessage — 注册表语义', () => {
    it('子会话运行中：入队返回 true，且队列引用与传给 agentLoop 的一致', async () => {
        const written = mockRepo()
        const gate = mockAgentLoopStream([text('输出'), done()])
        const ctx = makeContext()
        const resultP = agentTool.execute({task: '做点事', agent: 'General Agent', modelRole: 'primary'} as any, ctx as any)

        await vi.waitFor(() => expect(vi.mocked(agentLoop).mock.calls.length).toBe(1))
        const loopArgs = vi.mocked(agentLoop).mock.calls[0][0] as {sessionId: string; pendingInjectedMessages: ChatMessage[]}

        expect(injectChildMessage(loopArgs.sessionId, '运行中补充', 'inject-9')).toBe(true)
        expect(loopArgs.pendingInjectedMessages).toEqual([{role: 'user', content: '运行中补充', id: 'inject-9'}])

        gate.resolve()
        await resultP
        expect(written.length).toBeGreaterThan(0)
    })

    it('子会话未运行 / 已结束：返回 false（finally 清理注册表，不泄漏）', async () => {
        const mockRepoWrites = mockRepo()
        const gate = mockAgentLoopStream([done()])
        const resultP = agentTool.execute({task: '做点事', agent: 'General Agent', modelRole: 'primary'} as any, makeContext() as any)

        await vi.waitFor(() => expect(vi.mocked(agentLoop).mock.calls.length).toBe(1))
        const loopArgs = vi.mocked(agentLoop).mock.calls[0][0] as {sessionId: string}
        gate.resolve()
        await resultP

        // 运行结束后注册表已清理：再次注入返回 false
        expect(injectChildMessage(loopArgs.sessionId, '迟到的消息')).toBe(false)
        expect(injectChildMessage('conv-never-existed', 'x')).toBe(false)
        expect(mockRepoWrites.length).toBeGreaterThan(0)
    })
})

// ─── user_message_injected → 累积器轮换（集成） ─────────────

describe('agentTool execute — user_message_injected 轮换累积器', () => {
    it('注入后累积器轮换：新旧 assistant 消息 id 不同，旧消息带 endedAt，新内容进新消息', async () => {
        const {result, written} = await runAgentTool([text('第一段'), injected, text('第二段'), done()])

        expect(result.success).toBe(true)
        const assistantMsgs = written.flatMap(w => w.messages).filter(m => m.role === 'assistant')
        const ids = [...new Set(assistantMsgs.map(m => m.id))]
        // 至少出现两个不同 id：注入前的消息 + 轮换后的新消息
        expect(ids.length).toBeGreaterThanOrEqual(2)

        const lastOfOld = [...assistantMsgs].reverse().find(m => m.id === ids[0])
        expect(lastOfOld?.endedAt).toBeGreaterThan(0)

        // 注入后的文本落在轮换后的新消息中
        const newMsgs = assistantMsgs.filter(m => m.id === ids[ids.length - 1])
        expect(newMsgs.some(m => m.content === '第二段')).toBe(true)
    })

    it('注入事件不被吞：仍转发到子会话渲染流，且注入后的 text 携带新 messageId', async () => {
        await runAgentTool([text('第一段'), injected, text('第二段'), done()])

        const events = childAgentEvents()
        // user_message_injected 必须被转发（渲染端 handleUserMessageInjected 清空 streamingMessageId）
        expect(events.some(e => e.type === 'user_message_injected')).toBe(true)

        // 注入前后的 text 分别携带轮换前/后的累积器消息 id
        const firstText = events.find(e => e.type === 'text' && (e as any).content === '第一段') as any
        const secondText = events.find(e => e.type === 'text' && (e as any).content === '第二段') as any
        expect(firstText.messageId).toBeDefined()
        expect(secondText.messageId).toBeDefined()
        expect(secondText.messageId).not.toBe(firstText.messageId)
    })
})
