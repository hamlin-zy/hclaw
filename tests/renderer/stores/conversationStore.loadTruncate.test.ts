/**
 * conversationStore 加载路径内存截断回归测试（内存泄漏修复）
 *
 * 覆盖：
 * - loadMessagesInitial：从 DB 水合的大 toolResult 进 messagesMap 前已被截断，
 *   但 conversationReadTail 返回的原始完整 content 仍在（DB 未被破坏，LLM 通路完好）
 * - loadMessagesInitial：小 toolResult / 无 toolCalls 的消息不截断
 * - loadMoreMessages：翻页加载的旧消息同样在进内存前被截断
 *
 * ★ 关键设计：断言 DB 原始数据（conversationReadTail/conversationReadBefore 返回值）
 *   仍是完整内容，证明截断只发生在渲染内存副本上，不影响主进程 LLM 上下文（execution.ts:72）。
 *   由于 truncateLargeResults 是模块级非导出函数，通过 store 行为 + mock window.electronAPI
 *   验证内存副本，DB 原始内容由 mock 闭包独立捕获。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

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

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const MEMORY_CAP = 2000
const TRUNC_PROMPT = '\n\n*(输出过长，已截断。展开加载完整内容)*'
const BIG_LEN = 10 * 1024
const BIG_OUTPUT = 'X'.repeat(BIG_LEN)
const SMALL_OUTPUT = 'small-ok'

/** 从 DB 返回（模拟 conversationReadTail / conversationReadBefore 的完整 result） */
function makeToolMsg(id: string, role: Message['role'], content: string, outputs: string[], ts: number): Message {
    return {
        id,
        role,
        content,
        timestamp: ts,
        ...(outputs.length > 0 ? {
            toolCalls: outputs.map((output, i) => ({
                id: `tc-${id}-${i}`,
                name: 'bash',
                arguments: {cmd: 'echo'},
                status: 'success' as const,
                result: {output},
            })),
        } : {}),
    }
}

let readTailCalls: Array<{convId: string; pageSize: number}>
let readBeforeCalls: Array<{convId: string; beforeTs: number; pageSize: number}>
let readMessagesCalls: string[]
let dbTailReturn: {messages: Message[]; totalCount: number}
let dbBeforeReturn: {messages: Message[]; totalCount: number}
let dbReadMessagesReturn: Message[]

beforeEach(() => {
    readTailCalls = []
    readBeforeCalls = []
    readMessagesCalls = []
    dbTailReturn = {messages: [], totalCount: 0}
    dbBeforeReturn = {messages: [], totalCount: 0}
    dbReadMessagesReturn = []
    ;(globalThis as any).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async (convId: string, pageSize?: number) => {
                readTailCalls.push({convId, pageSize: pageSize!})
                return dbTailReturn
            }),
            conversationReadBefore: vi.fn(async (convId: string, beforeTs: number, pageSize?: number) => {
                readBeforeCalls.push({convId, beforeTs, pageSize: pageSize!})
                return dbBeforeReturn
            }),
            conversationReadMessages: vi.fn(async (convId: string) => {
                readMessagesCalls.push(convId)
                return dbReadMessagesReturn
            }),
        },
    }
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: 'conv-1',
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {'conv-1': []},
        loadedMessages: [],
        loadingMoreMap: {'conv-1': false},
        hasMoreMap: {'conv-1': false},
    })
})

afterEach(() => {
    vi.useRealTimers()
})

describe('loadMessagesInitial — 从 DB 水合的内存截断', () => {
    it('大 toolResult 水合进内存前被截断，但 DB 原始完整 content 仍在', async () => {
        // DB（conversationReadTail）返回完整大 output
        dbTailReturn = {
            messages: [makeToolMsg('m-big', 'assistant', '正文', [BIG_OUTPUT], 100)],
            totalCount: 1,
        }
        await useConversationStore.getState().loadMessagesInitial('conv-1')

        // 内存副本被截断
        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        const out = inMem.toolCalls![0].result!.output as string
        expect(out).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect(out.length).toBeLessThan(BIG_LEN)
        expect((inMem.toolCalls![0].result as any)._fullOutputStored).toBe(true)
        expect((inMem.toolCalls![0].result as any)._outputTruncatedLength).toBe(BIG_LEN)

        // ★ DB 原始数据未被破坏：conversationReadTail 返回值仍是完整内容，
        //   证明截断只作用于渲染内存副本，不影响主进程 LLM 上下文（execution.ts:72）
        const dbResult = (dbTailReturn.messages[0].toolCalls![0].result as any).output as string
        expect(dbResult).toBe(BIG_OUTPUT)
        expect(dbResult).not.toContain('已截断')
        expect(dbResult.length).toBe(BIG_LEN)
    })

    it('小 toolResult 水合后不截断', async () => {
        dbTailReturn = {
            messages: [makeToolMsg('m-small', 'assistant', '正文', [SMALL_OUTPUT], 100)],
            totalCount: 1,
        }
        await useConversationStore.getState().loadMessagesInitial('conv-1')

        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(inMem.toolCalls![0].result!.output).toBe(SMALL_OUTPUT)
        expect((inMem.toolCalls![0].result as any)._fullOutputStored).toBeUndefined()
    })

    it('无 toolCalls 的消息水合后保持原样', async () => {
        dbTailReturn = {
            messages: [makeToolMsg('m-plain', 'assistant', '纯文本正文', [], 100)],
            totalCount: 1,
        }
        await useConversationStore.getState().loadMessagesInitial('conv-1')

        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        expect(inMem.content).toBe('纯文本正文')
        expect(inMem.toolCalls).toBeUndefined()
    })
})

describe('loadMoreMessages — 翻页加载的旧消息也在进内存前截断', () => {
    it('大 toolResult 翻页读回前被截断，DB 原始完整内容仍完好', async () => {
        // 先有初始消息（触发 loadMoreMessages 分支）
        dbTailReturn = {
            messages: [makeToolMsg('m-newest', 'assistant', '最新', [SMALL_OUTPUT], 200)],
            totalCount: 2,
        }
        await useConversationStore.getState().loadMessagesInitial('conv-1')

        // 翻页读回更早的大 toolResult 消息
        dbBeforeReturn = {
            messages: [makeToolMsg('m-old', 'assistant', '更早', [BIG_OUTPUT], 100)],
            totalCount: 2,
        }
        await useConversationStore.getState().loadMoreMessages('conv-1', 2)

        const msgs = useConversationStore.getState().messagesMap['conv-1']
        const oldMsg = msgs.find(m => m.id === 'm-old')!
        const out = oldMsg.toolCalls![0].result!.output as string
        expect(out).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect((oldMsg.toolCalls![0].result as any)._fullOutputStored).toBe(true)

        // DB 原始数据完好
        const dbOldResult = (dbBeforeReturn.messages[0].toolCalls![0].result as any).output as string
        expect(dbOldResult).toBe(BIG_OUTPUT)
        expect(dbOldResult.length).toBe(BIG_LEN)
    })
})

describe('loadMessages — 全量读回（启动/压缩/渠道 reload）也在进内存前截断', () => {
    it('大 toolResult 全量读回进内存前被截断，DB 原始完整内容仍完好', async () => {
        dbReadMessagesReturn = [makeToolMsg('m-full', 'assistant', '全量', [BIG_OUTPUT], 100)]
        await useConversationStore.getState().loadMessages('conv-1')

        expect(readMessagesCalls).toEqual(['conv-1'])
        const inMem = useConversationStore.getState().messagesMap['conv-1'][0]
        const out = inMem.toolCalls![0].result!.output as string
        expect(out).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect((inMem.toolCalls![0].result as any)._fullOutputStored).toBe(true)

        // DB 原始数据完好（conversationReadMessages 返回的仍是完整内容）
        const dbResult = (dbReadMessagesReturn[0].toolCalls![0].result as any).output as string
        expect(dbResult).toBe(BIG_OUTPUT)
        expect(dbResult.length).toBe(BIG_LEN)
    })
})
