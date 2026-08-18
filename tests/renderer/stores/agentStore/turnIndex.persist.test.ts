// @vitest-environment jsdom
/**
 * turnIndex 落库链路测试（方案 2 根治）
 *
 * 保护：
 * 1. handleAgentStart 收到 agent_start 事件时递增 per-conversation turnIndex
 * 2. recordThinkBlock/recordTextBlock/recordToolCallBlock/recordToolResultBlock
 *    写入的 MessageBlock 携带当前 turnIndex
 * 3. 多轮 LLM 调用（agent_start 多次到达）产生递增的 turnIndex
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import type {BlockDeltaPatch, MessageBlock} from '@shared/types'

import {useConversationStore, flushConversationDirty} from '@/renderer/stores/conversationStore'
import {useAgentStore} from '@/renderer/stores/agentStore'
import {accumulateThinkingBatch, flushThinkingBatch} from '@/renderer/stores/agentStore/batching/thinkingBatch'
import {accumulateTextBatch, flushTextBatch} from '@/renderer/stores/agentStore/batching/textBatch'
import {flushToolResultBatch, getToolResultBatch} from '@/renderer/stores/agentStore/batching/toolResultBatch'
import {handleToolUse} from '@/renderer/stores/agentStore/handlers/streamTools'
import {handleAgentStart} from '@/renderer/stores/agentStore/handlers/streamCore'
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
    useConversationStore.getState().cancelPendingSave()
    await flushConversationDirty('conv-1')
})

/** 收集所有已落库块（跨 flush 调用去重合并） */
function allPersistedBlocks(): MessageBlock[] {
    const byId = new Map<string, MessageBlock>()
    for (const call of blockDeltaCalls) {
        for (const b of call.patch.upsertBlocks ?? []) byId.set(b.id, b)
    }
    return [...byId.values()]
}

describe('turnIndex 落库链路（方案 2）', () => {
    it('agent_start 递增 turnIndex，后续块携带当前 turnIndex', async () => {
        const msgId = 'msg-1'

        // 第 1 轮 LLM 调用：agent_start（turn 0）
        handleAgentStart(makeCtx('conv-1', {
            type: 'agent_start', agentType: 'General', agentId: 'a1', model: 'm', tools: [],
        }))
        expect(useAgentStore.getState().convAgentStates['conv-1']!.currentTurnIndex).toBe(0)

        accumulateThinkingBatch('conv-1', '第一轮思考')
        flushThinkingBatch('conv-1')
        await flushConversationDirty('conv-1')

        // 第 2 轮 LLM 调用：agent_start（turn 1）
        handleAgentStart(makeCtx('conv-1', {
            type: 'agent_start', agentType: 'General', agentId: 'a1', model: 'm', tools: [],
        }))
        expect(useAgentStore.getState().convAgentStates['conv-1']!.currentTurnIndex).toBe(1)

        accumulateTextBatch('conv-1', '第二轮正文')
        flushTextBatch('conv-1', msgId)
        handleToolUse(makeCtx('conv-1', {
            type: 'tool_use',
            toolCall: {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}},
        }))
        getToolResultBatch('conv-1').set('tc-1', {
            toolCallId: 'tc-1',
            result: {success: true, output: 'OK'},
        })
        flushToolResultBatch('conv-1')
        await flushConversationDirty('conv-1')

        const blocks = allPersistedBlocks()
        // 第 1 轮块：turnIndex 0
        const thinkBlock = blocks.find(b => b.id === 'think-msg-1-0')!
        expect(thinkBlock.turnIndex).toBe(0)
        // 第 2 轮块：turnIndex 1
        const textBlock = blocks.find(b => b.blockType === 'text')!
        expect(textBlock.turnIndex).toBe(1)
        const tcBlock = blocks.find(b => b.blockType === 'tool_call')!
        expect(tcBlock.turnIndex).toBe(1)
        const trBlock = blocks.find(b => b.blockType === 'tool_result')!
        expect(trBlock.turnIndex).toBe(1)
    })

    it('done 收尾后 turnIndex 清除，下一用户 turn 重新从 0 计数', async () => {
        const msgId = 'msg-1'
        handleAgentStart(makeCtx('conv-1', {
            type: 'agent_start', agentType: 'General', agentId: 'a1', model: 'm', tools: [],
        }))
        accumulateThinkingBatch('conv-1', '思考')
        flushThinkingBatch('conv-1')
        await flushConversationDirty('conv-1')

        await handleDone(makeCtx('conv-1', {type: 'done', reason: 'completed'}))
        await vi.waitFor(() => {
            expect(blockDeltaCalls.some(c => c.patch.finalize === true)).toBe(true)
        })

        // done 收尾清除 turnIndex
        expect(useAgentStore.getState().convAgentStates['conv-1']!.currentTurnIndex).toBeUndefined()

        // 下一用户 turn：新 agent_start 从 0 重新计数
        handleAgentStart(makeCtx('conv-1', {
            type: 'agent_start', agentType: 'General', agentId: 'a1', model: 'm', tools: [],
        }))
        expect(useAgentStore.getState().convAgentStates['conv-1']!.currentTurnIndex).toBe(0)
    })

    it('无 agent_start 时块 turnIndex 为 undefined（兼容旧事件流）', async () => {
        const msgId = 'msg-1'
        accumulateThinkingBatch('conv-1', '思考')
        flushThinkingBatch('conv-1')
        await flushConversationDirty('conv-1')

        const blocks = allPersistedBlocks()
        const thinkBlock = blocks.find(b => b.blockType === 'think')!
        expect(thinkBlock.turnIndex).toBeUndefined()
    })
})
