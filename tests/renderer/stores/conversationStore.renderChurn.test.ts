/**
 * 渲染内存分配风暴 — updateMessageForConv / updateMessageBlockForConv 引用稳定性
 *
 * 背景（CDP 分配采样实证）：流式期间 textBatch 每 24ms flush 一次，
 * updateMessageForConv 把整个 messagesMap[convId] 数组 [...convMsgs] 复制一遍，
 * 导致 messagesMap 数组引用每次流式都变 → MessageList.visibleMessages (useMemo [messages])
 * 每次重建全数组（每条消息一个 {message, origIdx} 对象）→ 分配风暴 ~30MB/min。
 *
 * 本测试锁定：单条消息流式更新时，未变化消息的对象引用必须保持不变
 * （React.memo bail out 依赖），避免全列表重渲染。
 * 目标：让流式更新只替换变化的那条消息，未变化消息引用稳定。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const agentStoreState = vi.hoisted(() => ({convAgentStates: {} as Record<string, any>}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: agentStoreState.convAgentStates,
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

function makeMsg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): Message {
    return {id, role, content, timestamp: Date.now()}
}

// 捕获 blockDelta IPC 调用（记录真实落库参数，这里只关心不误触全量写）
let blockDeltaCalls: Array<{convId: string; msgId: string; patch: any}>

beforeEach(() => {
    blockDeltaCalls = []
    ;(globalThis as any).window = {
        electronAPI: {
            conversationWriteBlockDelta: vi.fn(async (convId: string, msgId: string, patch: any) => {
                blockDeltaCalls.push({convId, msgId, patch})
                return true
            }),
            conversationWriteMessages: vi.fn(async () => true),
            conversationWriteMessagesDelta: vi.fn(async () => true),
            conversationGetMessages: vi.fn(async () => [] as Message[]),
            conversationList: vi.fn(async () => []),
            workspaceGetCurrent: vi.fn(async () => null),
            taskBatchesGetActive: vi.fn(async () => null),
        },
    }
    useConversationStore.setState({currentWorkspacePath: '/ws', activeConversationId: 'conv-1', messagesMap: {}})
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('流式更新引用稳定性 — 未变化消息引用保持（防全列表重建）', () => {
    it('更新单条消息：仅变化消息替换，未变化消息对象引用不变', () => {
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', makeMsg('m-1', '历史1', 'user'))
        store.addMessageToConv('conv-1', makeMsg('m-2', '历史2', 'assistant'))
        store.addMessageToConv('conv-1', makeMsg('m-3', '历史3', 'assistant'))
        const before = useConversationStore.getState().messagesMap['conv-1']
        const refM1 = before.find(m => m.id === 'm-1')!
        const refM3 = before.find(m => m.id === 'm-3')!

        // 流式更新 m-2
        useConversationStore.getState().updateMessageForConv('conv-1', 'm-2', {content: 'm-2 更新内容'})
        const after = useConversationStore.getState().messagesMap['conv-1']

        // ★ 全数组引用必须保持（这不是关键，关键是未变化消息引用）
        const afterM1 = after.find(m => m.id === 'm-1')!
        const afterM3 = after.find(m => m.id === 'm-3')!
        expect(afterM1).toBe(refM1)  // 未变化消息对象引用不变
        expect(afterM3).toBe(refM3)
        expect(after.find(m => m.id === 'm-2')!.content).toBe('m-2 更新内容')
    })

    it('块级增量 updateMessageBlockForConv：未变化块引用保持', () => {
        const store = useConversationStore.getState()
        store.addMessageToConv('conv-1', {
            id: 'm-stream', role: 'assistant', content: '',
            contentBlocks: [
                {id: 'text-1', type: 'text', text: '段1'},
                {id: 'think-1', type: 'think', thinkBlock: {id: 'think-1', content: '思考', status: 'thinking'}},
            ],
        } as any)
        const before = useConversationStore.getState().messagesMap['conv-1']
        const msgBefore = before.find(m => m.id === 'm-stream')!
        const thinkBlockRef = msgBefore.contentBlocks!.find(b => b.id === 'think-1')!

        // 块级替换 text 块
        useConversationStore.getState().updateMessageBlockForConv('conv-1', 'm-stream', 'text-1', {id: 'text-1', type: 'text', text: '段1-更新'})

        const after = useConversationStore.getState().messagesMap['conv-1']
        const msgAfter = after.find(m => m.id === 'm-stream')!
        expect(msgAfter.contentBlocks!.find(b => b.id === 'think-1')).toBe(thinkBlockRef) // think 块引用不变
        expect(msgAfter.contentBlocks!.find(b => b.id === 'text-1')!.text).toBe('段1-更新')
    })
})
