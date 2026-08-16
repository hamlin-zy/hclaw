/**
 * conversationStore 大型工具结果截断（内存副本）单元测试
 *
 * 覆盖：
 * - truncateLargeResults：>5000 字符工具 output 被截断（保留前 5000 + 截断提示 +
 *   _fullOutputStored/_outputTruncatedLength 标记）；≤5000 不动；无 toolCalls 不动；output 非 string 跳过
 * - 块级增量是完整内容的唯一权威：recordToolResultBlock 在截断前写完整 tool_result 块，
 *   截断后内存副本不持有完整内容（完整内容只在 DB 块）
 * - saveMessages 无 dirty 时不再调用全量写（全量写兜底已移除）
 * - 幂等短路：同一消息二次 truncateLargeResults 不二次截断
 *
 * truncateLargeResults 是模块级非导出函数，通过 conversationStore 行为 + mock window.electronAPI
 * 捕获写库内容间接验证。
 * 隔离：每个用例使用独立 message id。
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

import {useConversationStore, recordToolResultBlock, flushConversationDirty} from '../../../src/renderer/stores/conversationStore'

const MEMORY_CAP = 5000
const TRUNC_PROMPT = '\n\n*(输出过长，已截断。展开加载完整内容)*'
const BIG_LEN = 10 * 1024
const BIG_OUTPUT = 'X'.repeat(BIG_LEN)
const SMALL_OUTPUT = 'small-ok'

let fullCalls: Array<{convId: string; messages: Message[]}>
let blockDeltaCalls: Array<{convId: string; msgId: string; patch: any}>

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
    fullCalls = []
    blockDeltaCalls = []
    ;(globalThis as any).window = {
        electronAPI: {
            conversationWriteBlockDelta: vi.fn(async (convId: string, msgId: string, patch: any) => {
                blockDeltaCalls.push({convId, msgId, patch})
                return true
            }),
            conversationWriteMessages: vi.fn(async (convId: string, messages: Message[]) => {
                fullCalls.push({convId, messages})
                return true
            }),
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
    it('>5000 字符的工具结果被截断：内存保留前 5000 + 提示 + 标记', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-big', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)

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

    it('幂等短路：同一消息二次 truncateLargeResults 不二次截断，_outputTruncatedLength 保持原值', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeToolMsg('m-idem', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)
        const afterFirst = useConversationStore.getState().messagesMap['conv-1'][0].toolCalls![0].result!

        // 仅改正文触发第二次 flush（toolCalls 未变）→ truncateLargeResults 再次执行
        store.updateMessageForConv('conv-1', 'm-idem', {content: '更新后的正文'})
        await vi.advanceTimersByTimeAsync(31000)

        const afterSecond = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(afterSecond.content).toBe('更新后的正文')
        // 未二次截断：仍是 5000 + 提示（若二次截断，长度会更短且内容被再次 slice）
        expect(afterSecond.toolCalls![0].result!.output).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect((afterSecond.toolCalls![0].result as any)._outputTruncatedLength).toBe(BIG_LEN)
        expect((afterFirst as any)._outputTruncatedLength).toBe(BIG_LEN)
    })

    it('截断后内存副本确实被截断（messagesMap 中是 5000+ 提示）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-mem-1', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(1200)

        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(inMem.toolCalls![0].result!.output).toContain('已截断')
        expect(inMem.toolCalls![0].result!.output.length).toBeLessThan(BIG_LEN)
    })
})

describe('块级增量是完整内容的唯一权威', () => {
    it('recordToolResultBlock 在截断前写完整 tool_result 块，截断后内存副本不持有完整内容', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-blk', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(0)

        // 模拟 tool_result 事件到达：完整 result 记账为 tool_result 块（截断发生前）
        const fullTc = {
            id: 'tc-m-blk-0',
            name: 'bash',
            arguments: {cmd: 'echo'},
            status: 'success',
            result: {output: BIG_OUTPUT},
        } as any
        recordToolResultBlock('conv-1', 'm-blk', fullTc)
        await flushConversationDirty('conv-1')

        // 断言：tool_result 块 data 含完整 BIG_OUTPUT（非截断）
        const trCall = blockDeltaCalls.find(c =>
            c.msgId === 'm-blk' && c.patch.upsertBlocks?.some((b: any) => b.blockType === 'tool_result')
        )
        expect(trCall).toBeTruthy()
        const trBlock = trCall!.patch.upsertBlocks!.find((b: any) => b.blockType === 'tool_result')!
        const data = JSON.parse(trBlock.data!)
        expect(data.result.output).toBe(BIG_OUTPUT)
        expect(data.result.output).not.toContain('已截断')

        // 截断后内存副本是截断的（完整内容只在 DB 块）
        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(inMem.toolCalls![0].result!.output).toContain('已截断')
    })

    it('saveMessages 无 dirty 时不再调用全量写（全量写兜底已移除）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeToolMsg('m-nofull', '正文', [BIG_OUTPUT]))
        await vi.advanceTimersByTimeAsync(31000) // 等所有 dirty flush 完
        await store.saveMessages()
        expect(fullCalls.length).toBe(0)
    })
})
