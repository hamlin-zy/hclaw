/**
 * conversationStore 大型工具结果截断 + side cache 回填 单元测试（Task 4：Critical 守护）
 *
 * 覆盖：
 * - truncateLargeResults：>5000 字符工具 output 被截断（保留前 5000 + 截断提示 +
 *   _fullOutputStored/_outputTruncatedLength 标记）；≤5000 不动；无 toolCalls 不动；output 非 string 跳过
 * - side cache 回填（核心）：10KB 工具结果 → addMessageToConv → flush → DB 收到完整 10KB 内容
 * - 二次更新不回写截断副本（Critical 场景）：截断后追加第二个工具结果再次 flush，
 *   第一次工具的完整内容仍从 cache 回填写库
 * - 幂等短路：同一消息两次 truncateLargeResults，第二次不二次截断
 * - 截断后内存副本确实被截断（messagesMap 中是 5000+ 提示，DB 写完整）
 *
 * truncateLargeResults / fullToolOutputCache 是模块级非导出函数，通过 conversationStore
 * 行为 + mock window.electronAPI.conversationWriteMessagesDelta 捕获写库内容间接验证。
 * 隔离：每个用例使用独立 message id（fullToolOutputCache 按 messageId 键控，避免跨用例残留）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

// mock agentStore（conversationStore 依赖它，但仅 action 内部惰性调用 getState）
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            getState: () => ({convAgentStates: {}, activeConversationId: null}),
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

// mock search（纯函数，真实实现也可用，但保持轻量）
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const MEMORY_CAP = 5000
const TRUNC_PROMPT = '\n\n*(输出过长，已截断。展开加载完整内容)*'
const BIG_LEN = 10 * 1024
const BIG_OUTPUT = 'X'.repeat(BIG_LEN)
const SMALL_OUTPUT = 'small-ok'

let deltaCalls: Array<{convId: string; message: Message}>

function makeToolMsg(id: string, content: string, outputs: string[]): Message {
    return {
        id,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        toolCalls: outputs.map((output, i) => ({
            id: `tc-${id}-${i}`,
            name: 'bash',
            arguments: {cmd: 'echo'},
            status: 'success' as const,
            result: {output},
        })),
    }
}

function makePlainMsg(id: string, content: string): Message {
    return {id, role: 'assistant', content, timestamp: Date.now()}
}

beforeEach(() => {
    deltaCalls = []
    ;(globalThis as any).window = {
        electronAPI: {
            conversationWriteMessagesDelta: vi.fn(async (convId: string, message: Message) => {
                deltaCalls.push({convId, message})
                return true
            }),
            conversationWriteMessages: vi.fn(async () => true),
        },
    }
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: 'conv-1',
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {'conv-1': []},
        loadedMessages: [],
    })
})

afterEach(() => {
    vi.useRealTimers()
    useConversationStore.getState().cancelPendingSave()
})

describe('truncateLargeResults — 大型工具结果截断（内存副本）', () => {
    it('>5000 字符的工具结果被截断：内存保留前 5000 + 提示 + 标记，DB 写入完整内容', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-big', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)

        // DB 收到完整内容（首次写入发生在截断之前）
        expect(deltaCalls).toHaveLength(1)
        expect(deltaCalls[0].message.toolCalls![0].result!.output).toBe(BIG_OUTPUT)

        // 内存副本确实被截断：前 5000 字符 + 提示 + 标记
        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        const out = inMem.toolCalls![0].result!.output
        expect(out).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect(out.length).toBe(MEMORY_CAP + TRUNC_PROMPT.length)
        expect((inMem.toolCalls![0].result as any)._fullOutputStored).toBe(true)
        expect((inMem.toolCalls![0].result as any)._outputTruncatedLength).toBe(BIG_LEN)
    })

    it('≤5000 字符的工具结果不动：内容原样保留，无截断标记', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-small', '正文', [SMALL_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)

        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(inMem.toolCalls![0].result!.output).toBe(SMALL_OUTPUT)
        expect((inMem.toolCalls![0].result as any)._fullOutputStored).toBeUndefined()
        expect((inMem.toolCalls![0].result as any)._outputTruncatedLength).toBeUndefined()
        expect(inMem.toolCalls![0].result!.output).not.toContain('已截断')
    })

    it('无 toolCalls 的消息不动：内容原样保留', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makePlainMsg('m-plain', '纯文本消息'))
        await vi.advanceTimersByTimeAsync(1200)

        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(inMem.content).toBe('纯文本消息')
        expect(inMem.toolCalls).toBeUndefined()
    })

    it('output 非 string 的工具结果跳过：不截断、无标记', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        const msg = makePlainMsg('m-nonstr', '正文')
        ;(msg as any).toolCalls = [{
            id: 'tc-nonstr-0',
            name: 'bash',
            arguments: {cmd: 'echo'},
            status: 'success',
            result: {output: 12345},
        }]
        store.addMessageToConv('conv-1', msg)
        await vi.advanceTimersByTimeAsync(1200)

        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        expect((inMem.toolCalls![0].result as any).output).toBe(12345)
        expect((inMem.toolCalls![0].result as any)._fullOutputStored).toBeUndefined()
        expect((inMem.toolCalls![0].result as any)._outputTruncatedLength).toBeUndefined()
    })
})

describe('side cache 回填 — DB 永远写入完整内容（Critical）', () => {
    it('10KB 工具结果 flush 落库时 DB 收到完整 10KB 内容（非截断版）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-cache-1', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)

        expect(deltaCalls).toHaveLength(1)
        expect(deltaCalls[0].message.toolCalls![0].result!.output).toHaveLength(BIG_LEN)
        expect(deltaCalls[0].message.toolCalls![0].result!.output).toBe(BIG_OUTPUT)
    })

    it('二次更新不回写截断副本：追加第二个工具结果再次 flush，第一个工具完整内容从 cache 回填', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        // 第一次 flush：DB 收到完整 10KB，内存副本被截断
        store.addMessageToConv('conv-1', makeToolMsg('m-cache-2', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)
        expect(deltaCalls).toHaveLength(1)
        expect(deltaCalls[0].message.toolCalls![0].result!.output).toBe(BIG_OUTPUT)
        // 内存确实被截断（验证后续写入确实面临"截断副本"风险）
        expect(useConversationStore.getState().messagesMap['conv-1'][0].toolCalls![0].result!.output)
            .toContain('已截断')

        // 追加第二个工具结果（部分更新：复用内存中已被截断的 toolCalls，spread 携带截断副本）
        // 关键：不再传入完整 10KB 输出 —— 若传入完整输出，即使删除 restoreFullToolOutputs
        // 回填逻辑该用例仍会通过（空转验证）。现在 toolCalls[0].output 就是截断副本，
        // 第二次 flush 时第一个工具的完整 10KB 只能靠 side cache 回填，删除回填逻辑即报警。
        const current = useConversationStore.getState().messagesMap['conv-1'][0]
        store.updateMessageForConv('conv-1', 'm-cache-2', {
            ...current,
            toolCalls: [
                ...current.toolCalls!,
                {
                    id: 'tc-m-cache-2-1',
                    name: 'bash',
                    arguments: {cmd: 'echo'},
                    status: 'success',
                    result: {output: SMALL_OUTPUT},
                },
            ],
        })
        await vi.advanceTimersByTimeAsync(2100)

        // 第二次写入：第一个工具仍为完整 10KB（从 side cache 回填，未用截断副本覆盖 DB）
        expect(deltaCalls.length).toBeGreaterThanOrEqual(2)
        const second = deltaCalls[deltaCalls.length - 1]
        expect(second.message.toolCalls![0].result!.output).toBe(BIG_OUTPUT)
        expect(second.message.toolCalls![0].result!.output).not.toContain('已截断')
        // 第二个工具（小输出）正常写库
        expect(second.message.toolCalls![1].result!.output).toBe(SMALL_OUTPUT)
    })

    it('幂等短路：同一消息二次 truncateLargeResults 不二次截断，_outputTruncatedLength 保持原值', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeToolMsg('m-idem', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)
        const afterFirst = useConversationStore.getState().messagesMap['conv-1'][0].toolCalls![0].result!

        // 仅改正文触发第二次 flush（toolCalls 未变）→ truncateLargeResults 再次执行
        store.updateMessageForConv('conv-1', 'm-idem', {content: '更新后的正文'})
        await vi.advanceTimersByTimeAsync(2100)

        const afterSecond = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(afterSecond.content).toBe('更新后的正文')
        // 未二次截断：仍是 5000 + 提示（若二次截断，长度会更短且内容被再次 slice）
        expect(afterSecond.toolCalls![0].result!.output).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect((afterSecond.toolCalls![0].result as any)._outputTruncatedLength).toBe(BIG_LEN)
        expect((afterFirst as any)._outputTruncatedLength).toBe(BIG_LEN)
        // 第二次写库仍携带完整内容（cache 回填），不因幂等跳过而丢失
        const last = deltaCalls[deltaCalls.length - 1]
        expect(last.message.toolCalls![0].result!.output).toBe(BIG_OUTPUT)
    })

    it('截断后内存副本确实被截断（messagesMap 中是 5000+ 提示，DB 是完整内容）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-mem-1', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)

        // 内存与 DB 两侧对比
        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        const dbOut = deltaCalls[0].message.toolCalls![0].result!.output
        expect(inMem.toolCalls![0].result!.output).toContain('已截断')
        expect(inMem.toolCalls![0].result!.output.length).toBeLessThan(BIG_LEN)
        expect(dbOut).toBe(BIG_OUTPUT)
        expect(dbOut).not.toContain('已截断')
    })
})
