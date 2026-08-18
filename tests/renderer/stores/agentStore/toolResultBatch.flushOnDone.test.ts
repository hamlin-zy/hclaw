// @vitest-environment jsdom
/**
 * 回归测试：handleDone 收尾同步冲刷 rAF 延迟的 tool_result 批（修复层 2）
 *
 * 背景（跨 turn 缓存断裂根因之一）：tool_result 经 scheduleToolResultUpdate 排队等
 * requestAnimationFrame。若 done 与工具结果同事件循环到达（工具结果就绪瞬间 loop 即
 * 收尾），rAF 尚未触发 → 修复前 handleDone 不冲刷批，tool_result 延后到下一帧才进
 * dirty map，而 finalizeMessageDelta（end 块）同步先进 → 两次 IPC 落库使 DB 块序变成
 * text → end → tool_result，重建序列与 loop 内存态逐 token 错位 → KV cache 断裂。
 *
 * 修复：handleDone 收尾前同步 flushToolResultBatch（空批 no-op），使 tool_result 与
 * finalize 同批落库——一次 IPC 内 upsertBlocks 先处理，end 块用 MAX(sequence)+1 恒在最后。
 *
 * 本测试锁定修复的核心场景：batch 中积压 tool_result 但 rAF 未触发时，handleDone
 * 必须把 tool_result 与 finalize 放进同一次 blockDelta patch。
 *
 * ★ 与 streamFlow.blockDelta.integration.test.ts 的区别：集成测试在 handleDone 前
 *   **手动** flushToolResultBatch（工具结果已先落库），本测试刻意不手动 flush，
 *   复刻「done 与 tool_result 同事件循环到达、rAF 未触发」的真实竞争场景——
 *   若有人删掉 handleDone 内的 flushToolResultBatch，本测试会立即失败。
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import type {BlockDeltaPatch} from '@shared/types'

import {useConversationStore, flushConversationDirty} from '@/renderer/stores/conversationStore'
import {useAgentStore} from '@/renderer/stores/agentStore'
import {
    getToolResultBatch,
    scheduleToolResultUpdate,
    clearToolResultBatchData,
} from '@/renderer/stores/agentStore/batching/toolResultBatch'
import {handleToolUse} from '@/renderer/stores/agentStore/handlers/streamTools'
import {handleDone} from '@/renderer/stores/agentStore/handlers/streamInteraction'
import type {StreamCtx} from '@/renderer/stores/agentStore/handlers/streamContext'

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
        currentTurnIndex: undefined,
        streamBlocks: [],
        streamingMessageId: 'msg-1',
        isThinkingAfterTools: false,
        runningToolCount: 0,
        executingToolsMessage: null,
        pendingMessages: [],
    })
    blockDeltaCalls = []
}

beforeEach(() => {
    blockDeltaCalls = []
    // ★ 冻结 rAF：真实环境 tool_result 经 scheduleToolResultUpdate 排队等 rAF 触发
    //   自动冲刷；测试必须模拟「done 与工具结果同事件循环到达、rAF 尚未触发」的
    //   竞争窗口，否则 rAF 兜底冲刷会掩盖 handleDone 内部冲刷被删的回归。
    //   冻结后 tool_result 的落库完全依赖 handleDone 内部 flushToolResultBatch。
    vi.stubGlobal('requestAnimationFrame', vi.fn())
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
    vi.unstubAllGlobals()
    // ★ 隔离：清空 toolResultBatch 模块级残留（失败用例可能遗留未冲刷的 batch 条目，
    //   污染下一用例的 scheduleToolResultUpdate 同 key 覆盖 → 掩盖回归）
    clearToolResultBatchData('conv-1')
    useConversationStore.getState().cancelPendingSave()
    await flushConversationDirty('conv-1')
})

/** 等待出现 finalize: true 的 blockDelta call 并返回它 */
async function waitForFinalizeCall() {
    await vi.waitFor(() => {
        expect(blockDeltaCalls.some(c => c.patch.finalize === true)).toBe(true)
    })
    return blockDeltaCalls.find(c => c.patch.finalize === true)!
}

describe('handleDone 收尾同步冲刷 tool_result 批（修复层 2）', () => {
    it('tool_result 积压在 batch（rAF 未触发）时：与 finalize 同批落库', async () => {
        // 流式过程中出现 tool_use（tool_call 块已入 dirty map）
        handleToolUse(makeCtx('conv-1', {
            type: 'tool_use',
            toolCall: {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}},
        }))

        // ★ 关键前置：工具结果已就绪但经排队等 rAF，此刻 rAF 未触发，batch 有积压。
        //   刻意不手动 flush —— 修复场景正是 handleDone 内部必须完成这次冲刷。
        getToolResultBatch('conv-1').set('tc-1', {
            toolCallId: 'tc-1',
            result: {success: true, output: 'OK'},
        })

        await handleDone(makeCtx('conv-1', {type: 'done'}))
        const finalizeCall = await waitForFinalizeCall()

        // ★ 核心断言：tool_result 块与 finalize 在同一个 patch（同批落库）。
        //   修复前：tool_result 延后到下一帧单独发 IPC → DB 块序 text → end → tool_result。
        const trBlocks = (finalizeCall.patch.upsertBlocks ?? []).filter(b => b.blockType === 'tool_result')
        expect(trBlocks).toHaveLength(1)
        expect(trBlocks[0].id).toBe('msg-1-tr-tc-1')
        expect(JSON.parse(trBlocks[0].data!)).toMatchObject({id: 'tc-1', result: {output: 'OK'}})
    })

    it('scheduleToolResultUpdate 真实排队入口：rAF 未触发时 handleDone 冲刷并同批落库', async () => {
        handleToolUse(makeCtx('conv-1', {
            type: 'tool_use',
            toolCall: {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}},
        }))

        // 真实入口：工具结果就绪走 scheduleToolResultUpdate 排队（rAF 尚未触发）
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: true, output: 'OK'})

        await handleDone(makeCtx('conv-1', {type: 'done'}))
        const finalizeCall = await waitForFinalizeCall()

        const trBlocks = (finalizeCall.patch.upsertBlocks ?? []).filter(b => b.blockType === 'tool_result')
        expect(trBlocks).toHaveLength(1)
        expect(JSON.parse(trBlocks[0].data!)).toMatchObject({id: 'tc-1', result: {output: 'OK'}})
    })

    it('空批时 handleDone 正常 finalize（flush 对空批 no-op，不破坏原流程）', async () => {
        // 无工具调用场景：batch 为空，handleDone 仍须正常收尾
        await handleDone(makeCtx('conv-1', {type: 'done'}))
        const finalizeCall = await waitForFinalizeCall()
        expect(finalizeCall.patch.finalize).toBe(true)
        // 无 tool_result 块（空批 no-op，不注入空数据）
        expect((finalizeCall.patch.upsertBlocks ?? []).some(b => b.blockType === 'tool_result')).toBe(false)
    })
})
