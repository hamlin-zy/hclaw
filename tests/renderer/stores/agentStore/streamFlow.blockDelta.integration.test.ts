// @vitest-environment jsdom
/**
 * 完整流式事件流 → 块级增量产出 集成测试（Task 4）
 *
 * 保护：think→text→tool_use→tool_result→done 全流程中，每个内容事件都必须经
 * 各 batch/handler 显式记账（recordTextBlock/recordThinkBlock/recordToolCallBlock/
 * recordToolResultBlock/finalizeMessageDelta），IPC 落库调用形状正确，最终
 * DB 等价终态：块 id 集合完整、无嵌套、无遗留扁平 think id（think-${msgId}）。
 *
 * 隔离：使用真实 conversationStore + 真实 agentStore + 真实 batch/handler，
 * 仅 mock window.electronAPI.conversationWriteBlockDelta（不触碰真实 IPC / SQLite）。
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import type {BlockDeltaPatch} from '@shared/types'

import {useConversationStore, flushConversationDirty} from '../../../../src/renderer/stores/conversationStore'
import {useAgentStore} from '../../../../src/renderer/stores/agentStore'
import {accumulateThinkingBatch, flushThinkingBatch} from '../../../../src/renderer/stores/agentStore/batching/thinkingBatch'
import {accumulateTextBatch, flushTextBatch} from '../../../../src/renderer/stores/agentStore/batching/textBatch'
import {flushToolResultBatch, getToolResultBatch} from '../../../../src/renderer/stores/agentStore/batching/toolResultBatch'
import {handleToolUse} from '../../../../src/renderer/stores/agentStore/handlers/streamTools'
import {handleDone} from '../../../../src/renderer/stores/agentStore/handlers/streamInteraction'
import {abortAgentImpl} from '../../../../src/renderer/stores/agentStore/handlers/abortAgent'
import type {StreamCtx} from '../../../../src/renderer/stores/agentStore/handlers/streamContext'

let blockDeltaCalls: Array<{convId: string; msgId: string; patch: BlockDeltaPatch}>

function makeCtx(convId: string, event: any): StreamCtx {
    return {
        set: vi.fn(),
        get: () => useAgentStore.getState() as any,
        convId,
        isActiveConv: true,
        isAgentAborted: false,
        event,
    }
}

function seedStores() {
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: 'conv-1',
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {'conv-1': []},
        loadedMessages: [],
    })
    useConversationStore.getState().addMessageToConv('conv-1', {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        toolCalls: [],
    })
    useAgentStore.getState().updateConvData('conv-1', {
        agentState: {status: 'running', mode: 'auto', phase: 'streaming'},
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        streamingMessageId: 'msg-1',
        isThinkingAfterTools: false,
        runningToolCount: 0,
        executingToolsMessage: null,
        pendingMessages: [],
    })
    // addMessageToConv 触发 throttle 首写（fire-and-forget），此处清空，断言只针对后续块级增量
    blockDeltaCalls = []
}

beforeEach(() => {
    blockDeltaCalls = []
    ;(globalThis as any).window = {
        electronAPI: {
            conversationWriteBlockDelta: vi.fn(async (convId: string, msgId: string, patch: BlockDeltaPatch) => {
                blockDeltaCalls.push({convId, msgId, patch})
                return true
            }),
        },
    }
    seedStores()
})

afterEach(async () => {
    // 清空 throttle timer / 残留 dirty，避免跨用例泄漏
    useConversationStore.getState().cancelPendingSave()
    await flushConversationDirty('conv-1')
})

describe('完整事件流块级增量产出（think→text→tool_use→tool_result→done）', () => {
    it('每个内容事件产生增量块：IPC 调用形状正确 + DB 等价终态无嵌套 id', async () => {
        const msgId = 'msg-1'

        // ── 段 1：think ──────────────────────────────────────────
        accumulateThinkingBatch('conv-1', '思考中')
        flushThinkingBatch('conv-1')
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls).toHaveLength(1)
        expect(blockDeltaCalls[0].msgId).toBe(msgId)
        expect(blockDeltaCalls[0].patch.upsertBlocks).toContainEqual(expect.objectContaining({
            id: 'think-msg-1-0',
            blockType: 'think',
            content: '思考中',
        }))

        // ── 段 2：text ───────────────────────────────────────────
        accumulateTextBatch('conv-1', '正文内容')
        flushTextBatch('conv-1', msgId)
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls).toHaveLength(2)
        expect(blockDeltaCalls[1].patch.upsertBlocks).toContainEqual(expect.objectContaining({
            id: 'text-msg-1-1', // textSeq=1：streamBlocks 中已有 1 个 think 块（think-msg-1-0）
            blockType: 'text',
            content: '正文内容',
        }))

        // ── 段 3：tool_use → tool_call 块 ─────────────────────────
        handleToolUse(makeCtx('conv-1', {
            type: 'tool_use',
            toolCall: {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}},
        }))
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls).toHaveLength(3)
        const tcBlock = blockDeltaCalls[2].patch.upsertBlocks!.find(b => b.id === 'msg-1-tc-tc-1')
        expect(tcBlock).toBeDefined()
        expect(tcBlock!.blockType).toBe('tool_call')
        expect(JSON.parse(tcBlock!.data!)).toMatchObject({
            id: 'tc-1', name: 'bash', status: 'running',
            textOffset: 4, // streamBuffer.length（'正文内容' 之后）
        })

        // ── 段 4：tool_result → tool_result 块（含完整 result） ──
        getToolResultBatch('conv-1').set('tc-1', {
            toolCallId: 'tc-1',
            result: {success: true, output: 'OK'},
        })
        flushToolResultBatch('conv-1')
        await flushConversationDirty('conv-1')
        expect(blockDeltaCalls).toHaveLength(4)
        const trBlock = blockDeltaCalls[3].patch.upsertBlocks!.find(b => b.id === 'msg-1-tr-tc-1')
        expect(trBlock).toBeDefined()
        expect(trBlock!.blockType).toBe('tool_result')
        expect(JSON.parse(trBlock!.data!)).toMatchObject({id: 'tc-1', result: {output: 'OK'}})

        // ── 段 5：done → think status 覆盖 complete + finalize ──
        await handleDone(makeCtx('conv-1', {type: 'done'}))
        // handleDone 内部 void flushConversationDirty —— 等微任务完成
        await vi.waitFor(() => {
            expect(blockDeltaCalls.some(c => c.patch.finalize === true)).toBe(true)
        })
        const finalCall = blockDeltaCalls.find(c => c.patch.finalize === true)!
        expect(finalCall.msgId).toBe(msgId)
        expect(finalCall.patch.messageFields?.endedAt).toBeTypeOf('number')
        // ★ ledger 补充：DB 中最后 think 块 status 覆盖为 complete
        const thinkBlock = finalCall.patch.upsertBlocks!.find(b => b.id === 'think-msg-1-0')
        expect(thinkBlock).toBeDefined()
        expect(JSON.parse(thinkBlock!.data!)).toMatchObject({
            id: 'think-msg-1-0',
            content: '思考中',
            status: 'complete',
        })

        // ★ Minor 4：done 组装 text 块 id 统一派生（text-msg-1-<offset>），非 randomUUID
        const doneMsg = useConversationStore.getState().messagesMap['conv-1']!.find(m => m.id === msgId)!
        const doneTextBlocks = (doneMsg.contentBlocks ?? []).filter(cb => cb.type === 'text')
        expect(doneTextBlocks.length).toBeGreaterThan(0)
        for (const tb of doneTextBlocks) {
            expect(tb.id).toMatch(/^text-msg-1-\d+$/)
        }
        // 该流程中 text 段起点为 offset 0（'正文内容' 位于 think 之后）。
        // 注：contentBlocks 的 text id 用 offset 派生（textBlockId），块 delta 的 text id 用 textSeq 派生。
        expect(doneTextBlocks[0].id).toBe('text-msg-1-0')

        // ── DB 等价终态：块 id 集合完整、无嵌套、无遗留扁平 think id ──
        const allBlockIds = blockDeltaCalls.flatMap(c => c.patch.upsertBlocks ?? []).map(b => b.id)
        expect(new Set(allBlockIds)).toEqual(new Set([
            'think-msg-1-0',   // 段序号派生（非扁平 think-msg-1）
            'text-msg-1-1',    // textSeq=1：streamBlocks 中已有 1 个 think 块
            'msg-1-tc-tc-1',   // 主进程 tool_call 块 id 规范
            'msg-1-tr-tc-1',   // 主进程 tool_result 块 id 规范
        ]))
        // 无遗留扁平 think id / text id 嵌套派生
        expect(allBlockIds).not.toContain('think-msg-1')
        expect(allBlockIds).not.toContain('text-msg-1')
    })

    it('多 think 段（think→tool→think）done：DB 中所有 think 块 status 全部置 complete（Minor 5）', async () => {
        const msgId = 'msg-1'
        // 段 1 think（id think-msg-1-0）
        accumulateThinkingBatch('conv-1', '第一段思考')
        flushThinkingBatch('conv-1')
        // tool_use
        handleToolUse(makeCtx('conv-1', {
            type: 'tool_use',
            toolCall: {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}},
        }))
        // 段 2 think（工具后，id think-msg-1-1）
        accumulateThinkingBatch('conv-1', '第二段思考')
        flushThinkingBatch('conv-1')
        await flushConversationDirty('conv-1')

        await handleDone(makeCtx('conv-1', {type: 'done'}))
        await vi.waitFor(() => {
            expect(blockDeltaCalls.some(c => c.patch.finalize === true)).toBe(true)
        })
        const finalCall = blockDeltaCalls.find(c => c.patch.finalize === true)!
        const thinkBlocks = (finalCall.patch.upsertBlocks ?? []).filter(b => b.blockType === 'think')
        // ★ 关键断言：两个 think 段均被 ledger 置 complete（修复前只有最后一段被置 complete）
        expect(thinkBlocks.map(b => b.id).sort()).toEqual(['think-msg-1-0', 'think-msg-1-1'])
        for (const tb of thinkBlocks) {
            expect(JSON.parse(tb.data!)).toMatchObject({
                id: tb.id,
                status: 'complete',
            })
        }
        // 每段 think 内容保留（未丢失）
        const data0 = JSON.parse(thinkBlocks.find(b => b.id === 'think-msg-1-0')!.data!)
        const data1 = JSON.parse(thinkBlocks.find(b => b.id === 'think-msg-1-1')!.data!)
        expect(data0.content).toBe('第一段思考')
        expect(data1.content).toBe('第二段思考')
    })

    it('abort 组装 text 块 id 统一派生（Minor 4）：text-msg-1-<offset>，非 randomUUID', async () => {
        const msgId = 'msg-1'
        useAgentStore.getState().updateConvData('conv-1', {
            agentState: {status: 'running', mode: 'auto', phase: 'streaming'},
            streamBuffer: 'abort 正文内容',
            thinkingContent: null,
            streamBlocks: [
                {type: 'think', id: 'think-msg-1-0', textOffset: 0, thinkContent: '思考中'},
            ],
            streamingMessageId: msgId,
            isThinkingAfterTools: false,
            runningToolCount: 0,
            executingToolsMessage: null,
            pendingMessages: [],
        })
        await abortAgentImpl(vi.fn(), () => useAgentStore.getState() as any, 'conv-1')

        const msg = useConversationStore.getState().messagesMap['conv-1']!.find(m => m.id === msgId)!
        const textBlocks = (msg.contentBlocks ?? []).filter(cb => cb.type === 'text')
        expect(textBlocks.length).toBeGreaterThan(0)
        for (const tb of textBlocks) {
            expect(tb.id).toMatch(/^text-msg-1-\d+$/)
        }
        // 该流程中文本起点为 offset 0
        expect(textBlocks[0].id).toBe('text-msg-1-0')
        // 文本内容完整保留
        expect(textBlocks[0].text).toBe('abort 正文内容')
    })
})
