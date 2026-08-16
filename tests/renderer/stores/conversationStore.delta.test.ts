/**
 * conversationStore 块级增量落库（block-level delta persistence）单元测试
 *
 * 覆盖 Task 3 的块级增量记账改造：
 * - addMessageToConv / updateMessageForConv 只累积 messageFields（瘦身：不含块字段），
 *   flush 走 conversationWriteBlockDelta（不再走整条消息的 conversationWriteMessagesDelta）
 * - 高频流式更新被 throttle 合并：首个 chunk 立即写，30s 窗口内其余更新合并为一次兜底写
 * - 多条 dirty 消息一次性 flush，且只写变化的消息
 * - flushMessages（abort 场景）强制立即刷 dirty
 * - saveMessages 只刷 dirty，无 dirty 时不再全量写
 * - record/finalize 系列：recordTextBlock 按 offset 切块、recordThinkBlock 同 id 覆盖、
 *   finalizeMessageDelta 产出 finalize patch
 *
 * 隔离：mock window.electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'
import type {BlockDeltaPatch} from '@shared/types'
import {
    useConversationStore,
    flushConversationDirty,
    recordTextBlock,
    recordThinkBlock,
    finalizeMessageDelta,
} from '../../../src/renderer/stores/conversationStore'

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

function makeMsg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): Message {
    return {id, role, content, timestamp: Date.now()}
}

let deltaCalls: Array<{convId: string; message: Message}>
let fullCalls: Array<{convId: string; messages: Message[]}>
let blockDeltaCalls: Array<{convId: string; msgId: string; patch: BlockDeltaPatch}>

beforeEach(() => {
    deltaCalls = []
    fullCalls = []
    blockDeltaCalls = []
    ;(globalThis as any).window = {
        electronAPI: {
            // 旧整条消息 delta / 全量写通道 mock 保留：flush 已不走它们，
            // 仅用于断言不再被调用（全量写兜底路径已移除）。
            conversationWriteMessagesDelta: vi.fn(async (convId: string, message: Message) => {
                deltaCalls.push({convId, message})
                return true
            }),
            conversationWriteMessages: vi.fn(async (convId: string, messages: Message[]) => {
                fullCalls.push({convId, messages})
                return true
            }),
            conversationWriteBlockDelta: vi.fn(async (convId: string, msgId: string, patch: BlockDeltaPatch) => {
                blockDeltaCalls.push({convId, msgId, patch})
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
    // 清空 pending timers，避免跨用例泄漏
    useConversationStore.getState().cancelPendingSave()
})

describe('块级增量落库（delta-first）', () => {
    it('addMessageToConv 触发块级增量写，不触发全量写', async () => {
        vi.useFakeTimers()
        useConversationStore.getState().addMessageToConv('conv-1', makeMsg('m1', 'hello'))
        await vi.advanceTimersByTimeAsync(1200)

        expect(blockDeltaCalls.length).toBe(1)
        expect(blockDeltaCalls[0].msgId).toBe('m1')
        expect(blockDeltaCalls[0].patch.messageFields).toMatchObject({role: 'assistant'})
        expect(fullCalls.length).toBe(0)
    })

    it('高频流式更新被 throttle 合并为一次块级写', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        // 模拟流式 10 次增量更新（同一消息，行级字段变化经 messageFields 累积）
        for (let i = 0; i < 10; i++) {
            store.addMessageToConv('conv-1', makeMsg('m1', `chunk${i}`))
            store.updateMessageForConv('conv-1', 'm1', {agentName: `agent-${i}`})
        }
        // throttle 语义：首个 chunk 立即写（lastFlush=0 → 立即 flush）
        expect(blockDeltaCalls.length).toBe(1)
        // 30s 窗口内不产生兜底写（防御 THROTTLE_MS 回退到 2s 的回归）
        await vi.advanceTimersByTimeAsync(5000)
        expect(blockDeltaCalls.length).toBe(1)
        // 30s 兜底 timer 触发，合并为一次兜底写
        await vi.advanceTimersByTimeAsync(31000)
        expect(blockDeltaCalls.length).toBe(2)
        expect(blockDeltaCalls[0].msgId).toBe('m1')
        // 兜底写携带窗口内最新 messageFields（agentName 反映最后一次 updateMessageForConv）
        expect(blockDeltaCalls[1].patch.messageFields?.metadata).toMatchObject({agentName: 'agent-9'})
        expect(fullCalls.length).toBe(0)
    })

    it('多条不同消息各自入 dirty，flush 时全部写入', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        store.addMessageToConv('conv-1', makeMsg('m2', 'b'))
        await vi.advanceTimersByTimeAsync(31000)

        expect(blockDeltaCalls.length).toBe(2)
        expect(blockDeltaCalls.map(c => c.msgId).sort()).toEqual(['m1', 'm2'])
        expect(fullCalls.length).toBe(0)
    })

    it('flushMessages 强制立即刷 dirty（abort 场景）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        // throttle 首写立即发生
        expect(blockDeltaCalls.length).toBe(1)

        // 窗口内新增 dirty（不立即写，挂起兜底 timer）
        store.updateMessageForConv('conv-1', 'm1', {agentName: 'a2'})
        expect(blockDeltaCalls.length).toBe(1)

        // abort 场景：flushMessages 强制立即刷掉窗口内 dirty
        store.flushMessages()
        await Promise.resolve()

        expect(blockDeltaCalls.length).toBe(2)
        expect(blockDeltaCalls[1].patch.messageFields?.metadata).toMatchObject({agentName: 'a2'})
    })

    it('saveMessages 优先刷 dirty；无 dirty 时不再全量写（全量写兜底已移除）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        // 场景 1：窗口内存在 dirty → 只走块级增量，不走全量
        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        store.updateMessageForConv('conv-1', 'm1', {agentName: 'a2'})
        await store.saveMessages()
        expect(blockDeltaCalls.length).toBe(2) // 首写 + saveMessages 刷 dirty
        expect(fullCalls.length).toBe(0)

        // 场景 2：无 dirty（已 flush）→ 不再全量写
        await store.saveMessages()
        expect(fullCalls.length).toBe(0)
    })

    it('updateMessageForConv 修改后再次落库携带最新 messageFields', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'v1'))
        store.updateMessageForConv('conv-1', 'm1', {agentName: 'v2'})
        await vi.advanceTimersByTimeAsync(31000)

        expect(blockDeltaCalls).toHaveLength(2)
        // 首写（addMessageToConv 立即 flush）：无 agentName
        expect(blockDeltaCalls[0].patch.messageFields?.metadata?.agentName).toBeUndefined()
        // 兜底写携带最新 messageFields
        expect(blockDeltaCalls[1].patch.messageFields?.metadata).toMatchObject({agentName: 'v2'})
    })

    it('cancelPendingSave 后不再落库（compact 场景）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        // 窗口内新增 dirty，挂起兜底 timer
        store.updateMessageForConv('conv-1', 'm1', {agentName: 'a2'})
        expect(blockDeltaCalls.length).toBe(1)

        // compact 场景：取消待写（清除 throttle timer 与 dirty），不触发写入
        store.cancelPendingSave()

        await vi.advanceTimersByTimeAsync(5000)
        // 兜底 timer 已被清除 → 不产生额外写
        expect(blockDeltaCalls.length).toBe(1)
    })
})

describe('块级增量记账', () => {
    it('updateMessageForConv 只产生 messageFields（不含块），flush 走 conversationWriteBlockDelta', async () => {
        useConversationStore.getState().addMessageToConv('conv-1', {id: 'm1', role: 'assistant', content: 'x'})
        useConversationStore.getState().updateMessageForConv('conv-1', 'm1', {agentName: 'a'})
        await flushConversationDirty('conv-1')
        // addMessageToConv 触发首写（立即 flush），updateMessageForConv 累积的 messageFields 由显式 flush 写出
        expect(blockDeltaCalls).toHaveLength(2)
        const {convId, msgId, patch} = blockDeltaCalls[1]
        expect(convId).toBe('conv-1')
        expect(msgId).toBe('m1')
        expect(patch.upsertBlocks).toEqual([])
        expect(patch.messageFields).toMatchObject({role: 'assistant', timestamp: expect.any(Number)})
        expect(patch.messageFields!.metadata).toMatchObject({agentName: 'a'})
        // 块字段不进 messageFields（瘦身：metadata 不含 contentBlocks/content）
        expect(patch.messageFields!.metadata).not.toHaveProperty('contentBlocks')
        expect(patch.messageFields!.metadata).not.toHaveProperty('content')
    })

    it('recordTextBlock 同 textSeq 段内增量拼接：两次 flush 合并为一个 text 块（mergeBlocksById 语义）', async () => {
        // recordTextBlock 按 textSeq 派生 id：同一 textSeq（无 think/tool 时为 0）的两段文本复用同 id，
        // mergeBlocksById 合并 content（增量拼接），flush 时只发一块。这是 textSeq 方案的正确行为：
        // 同一 text 段内多次 flush 走 DB UPDATE 而非新 INSERT（O(segments) 而非 O(chunks)）。
        recordTextBlock('conv-1', 'm1', 'a'.repeat(500))
        recordTextBlock('conv-1', 'm1', 'b'.repeat(300))
        await flushConversationDirty('conv-1')
        const {patch} = blockDeltaCalls[blockDeltaCalls.length - 1]
        // 同 textSeq → 同 id text-m1-0，合并后仅一块，content 为两次增量的拼接
        expect(patch.upsertBlocks!.map(b => b.id)).toEqual(['text-m1-0'])
        expect(patch.upsertBlocks![0].content).toHaveLength(800)
        expect(patch.upsertBlocks![0].content).toBe('a'.repeat(500) + 'b'.repeat(300))
    })

    it('recordThinkBlock 同 id 段内增长：二次记账同一 id', async () => {
        recordThinkBlock('conv-1', 'm1', 'think-m1-0', '思考1', 'thinking', 0)
        recordThinkBlock('conv-1', 'm1', 'think-m1-0', '思考12', 'thinking', 0)
        await flushConversationDirty('conv-1')
        // 断言 upsertBlocks 仅 1 个，id think-m1-0，content '思考12'（后写覆盖）
        const {patch} = blockDeltaCalls[blockDeltaCalls.length - 1]
        expect(patch.upsertBlocks).toHaveLength(1)
        expect(patch.upsertBlocks![0].id).toBe('think-m1-0')
        expect(patch.upsertBlocks![0].content).toBe('思考12')
    })

    it('finalizeMessageDelta 产生 finalize patch', async () => {
        finalizeMessageDelta('conv-1', 'm1', 123)
        await flushConversationDirty('conv-1')
        // 断言 patch.finalize === true, messageFields.endedAt === 123
        const {patch} = blockDeltaCalls[blockDeltaCalls.length - 1]
        expect(patch.finalize).toBe(true)
        expect(patch.messageFields!.endedAt).toBe(123)
    })

    it('finalize-only 首写合并保留 role/timestamp/metadata（防消息行丢失）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        // 首条消息触发立即 flush（建立 throttle lastFlush，此后消息首写被推迟到边界/30s 兜底）
        store.addMessageToConv('conv-1', makeMsg('m1', 'first'))
        expect(blockDeltaCalls).toHaveLength(1)

        // 第二条消息：add 后无任何中间 flush/update/record，直接 finalize → 首次落库即 finalize-only 补丁
        store.addMessageToConv('conv-1', makeMsg('m2', 'second'))
        finalizeMessageDelta('conv-1', 'm2', 456)
        await flushConversationDirty('conv-1')

        // m2 的首写补丁必须仍携带 role/timestamp/metadata（与 endedAt 合并，而非被 {endedAt} 整体替换），
        // 否则主进程 writeBlockDelta 的 typeof role === 'string' 建行判空会失败 → 整条消息在 reload 后消失
        const {patch} = blockDeltaCalls[1]
        expect(patch.finalize).toBe(true)
        expect(patch.messageFields).toMatchObject({
            role: 'assistant',
            timestamp: expect.any(Number),
            metadata: expect.any(Object),
            endedAt: 456,
        })
        expect(patch.messageFields!.role).toBe('assistant')
    })

    it('updateMessageForConv → finalizeMessageDelta 序列：messageFields 合并而非替换', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'v1'))
        expect(blockDeltaCalls).toHaveLength(1)
        // 常规序列：行级字段变化累积 metadata，随后 finalize 追加 endedAt
        store.updateMessageForConv('conv-1', 'm1', {agentName: 'a2'})
        finalizeMessageDelta('conv-1', 'm1', 789)
        await flushConversationDirty('conv-1')

        const {patch} = blockDeltaCalls[blockDeltaCalls.length - 1]
        expect(patch.finalize).toBe(true)
        // role/timestamp/metadata 与 endedAt 并存（字段级合并，互不覆盖）
        expect(patch.messageFields).toMatchObject({
            role: 'assistant',
            timestamp: expect.any(Number),
            endedAt: 789,
        })
        expect(patch.messageFields!.metadata).toMatchObject({agentName: 'a2'})
    })
})

describe('flush 失败重试（设计 §8：IPC invoke 失败 → dirty 块保留，30s 兜底 timer 重试）', () => {
    it('主进程返回 false：dirty 保留，下次 flush 重发同一 patch（内容不丢）；成功后不再重发', async () => {
        let writeCount = 0
        // 覆盖 beforeEach 的 mock：首次 invoke 返回 false（模拟主进程 SQLite 写失败），后续成功
        ;(globalThis as any).window.electronAPI.conversationWriteBlockDelta = vi.fn(
            async (convId: string, msgId: string, patch: BlockDeltaPatch) => {
                blockDeltaCalls.push({convId, msgId, patch})
                writeCount++
                return writeCount < 2 ? false : true
            },
        )
        const msgId = 'm-retry-1'
        const content = '内容内容内容内容内容' // 10 字符
        recordTextBlock('conv-1', msgId, content)
        await flushConversationDirty('conv-1')

        // 首次 flush：invoke 已发出但返回 false → patch 保留在 dirty map（不丢）
        expect(blockDeltaCalls).toHaveLength(1)
        expect(blockDeltaCalls[0].msgId).toBe(msgId)
        expect(blockDeltaCalls[0].patch.upsertBlocks![0].content).toBe(content)

        // ★ 关键断言：失败后 dirty 保留 → 下次 flush 重发同一 patch。
        //   recordTextBlock 传增量文本，重试重发的就是首次构建好的增量 patch（内容不丢）。
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls).toHaveLength(2)
        expect(blockDeltaCalls[1].msgId).toBe(msgId)
        expect(blockDeltaCalls[1].patch.upsertBlocks![0].content).toBe(content)

        // 成功后 dirty 已清空，后续 flush 不再重复发送
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls).toHaveLength(2)
    })

    it('多条消息部分失败：仅失败项保留重试，成功项不重发', async () => {
        ;(globalThis as any).window.electronAPI.conversationWriteBlockDelta = vi.fn(
            async (convId: string, msgId: string, patch: BlockDeltaPatch) => {
                blockDeltaCalls.push({convId, msgId, patch})
                // m-retry-2 失败，m-retry-3 成功
                return msgId === 'm-retry-2' ? false : true
            },
        )
        recordTextBlock('conv-1', 'm-retry-2', '失败消息内容')
        recordTextBlock('conv-1', 'm-retry-3', '成功消息内容')
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls.map(c => c.msgId).sort()).toEqual(['m-retry-2', 'm-retry-3'])

        // 再次 flush：仅 m-retry-2（失败项）重发，m-retry-3 不再出现
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls).toHaveLength(3)
        expect(blockDeltaCalls[2].msgId).toBe('m-retry-2')
    })
})
