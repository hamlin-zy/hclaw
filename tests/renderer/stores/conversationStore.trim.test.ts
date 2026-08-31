/**
 * conversationStore.maybeTrimConversation 单元测试（Task 7：单会话内存权重上限）
 *
 * 覆盖：
 * - 权重 ≤500 不 trim（messagesMap 长度不变）
 * - 权重超限 → evict 最旧 30%（messagesMap 长度减少、hasMoreMap[convId]=true）
 * - 活跃会话（activeConversationId === convId）跳过 trim
 * - 非活跃会话才 trim
 * - 大工具结果（output >1000 字符）按真实字节计权（1000 字符 = 1 权重）
 * - evict 后 messagesMap 保留最新消息（最旧的被移除）
 *
 * maybeTrimConversation 由 addMessageToConv / updateMessageForConv 的
 * setTimeout(..., 0) 触发，用 vi.useFakeTimers + advanceTimersByTimeAsync(0) 执行。
 * 权重规则：base 1 + contentBlocks 数量 + 每个 toolCall 按 Math.ceil(output.length/1000) 计权。
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

const CONV = 'conv-bg'        // 被填充的会话（默认非活跃）
const ACTIVE = 'conv-active'  // 活跃会话（默认不参与填充）

/** 单条消息：base 1 + 工具结果 6001 字符（ceil(6001/1000)=7）= 权重 8 */
function makeHeavyToolMsg(id: string): Message {
    return {
        id,
        role: 'assistant',
        content: 'c',
        timestamp: Date.now(),
        toolCalls: [{
            id: 'tc-' + id,
            name: 'bash',
            arguments: {},
            status: 'success' as const,
            result: {output: 'o'.repeat(6001)}, // 6001 字符 → 权重 7（真实字节计权）
        }],
    }
}

/** 单条普通消息：权重 1（无 contentBlocks / toolCalls） */
function makePlainMsg(id: string): Message {
    return {id, role: 'assistant', content: 'c', timestamp: Date.now()}
}

function addMany(count: number, convId: string, maker: (id: string) => Message): void {
    const store = useConversationStore.getState()
    for (let i = 0; i < count; i++) {
        store.addMessageToConv(convId, maker(`m-${convId}-${i}`))
    }
}

beforeEach(() => {
    ;(globalThis as any).window = {
        electronAPI: {
        },
    }
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: ACTIVE,
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {[CONV]: [], [ACTIVE]: []},
        loadedMessages: [],
        hasMoreMap: {},
    })
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('maybeTrimConversation — 500 权重上限 + evict 30%', () => {
    it('权重 ≤500 不 trim：messagesMap 长度不变', async () => {
        // 60 × 8 = 480 ≤ 500
        addMany(60, CONV, makeHeavyToolMsg)
        await vi.advanceTimersByTimeAsync(0)

        expect(useConversationStore.getState().messagesMap[CONV]).toHaveLength(60)
        expect(useConversationStore.getState().hasMoreMap[CONV]).toBeFalsy()
    })

    it('权重超限 → evict 最旧 30%：长度减少 + hasMoreMap=true', async () => {
        // 85 × 6 = 510 > 500 → evict floor(85*0.3)=25，保留 60
        addMany(85, CONV, makeHeavyToolMsg)
        await vi.advanceTimersByTimeAsync(0)

        const msgs = useConversationStore.getState().messagesMap[CONV]
        expect(msgs).toHaveLength(60)
        expect(useConversationStore.getState().hasMoreMap[CONV]).toBe(true)
    })

    it('活跃会话（activeConversationId === convId）跳过 trim', async () => {
        vi.setSystemTime(1000)
        // 把活跃会话切到 CONV，填充超重消息 → 不 trim
        useConversationStore.setState({activeConversationId: CONV})
        addMany(85, CONV, makeHeavyToolMsg)
        await vi.advanceTimersByTimeAsync(0)

        expect(useConversationStore.getState().messagesMap[CONV]).toHaveLength(85)
        expect(useConversationStore.getState().hasMoreMap[CONV]).toBeFalsy()
    })

    it('非活跃会话才 trim：活跃会话超重不动，非活跃会话超重被 evict', async () => {
        // 活跃会话同样超重 → 跳过 trim，长度不变
        addMany(85, ACTIVE, makeHeavyToolMsg)
        await vi.advanceTimersByTimeAsync(0)
        expect(useConversationStore.getState().messagesMap[ACTIVE]).toHaveLength(85)
        expect(useConversationStore.getState().hasMoreMap[ACTIVE]).toBeFalsy()

        // 非活跃会话超重 → evict
        addMany(85, CONV, makeHeavyToolMsg)
        await vi.advanceTimersByTimeAsync(0)
        expect(useConversationStore.getState().messagesMap[CONV]).toHaveLength(60)
        expect(useConversationStore.getState().hasMoreMap[CONV]).toBe(true)
        // 活跃会话仍未被 trim
        expect(useConversationStore.getState().messagesMap[ACTIVE]).toHaveLength(85)
    })

    it('大工具结果（output>1000）权重计入：同样数量下工具消息超限而普通消息不超', async () => {
        // 84 条普通消息：权重 84 → 不 trim
        addMany(84, CONV, makePlainMsg)
        await vi.advanceTimersByTimeAsync(0)
        expect(useConversationStore.getState().messagesMap[CONV]).toHaveLength(84)
        expect(useConversationStore.getState().hasMoreMap[CONV]).toBeFalsy()

        // 84 条工具消息：权重 84×8=672 > 500 → trim（字节权重生效）
        useConversationStore.setState({messagesMap: {...useConversationStore.getState().messagesMap, [CONV]: []}})
        addMany(84, CONV, makeHeavyToolMsg)
        await vi.advanceTimersByTimeAsync(0)
        // floor(84*0.3)=25，保留 59
        expect(useConversationStore.getState().messagesMap[CONV]).toHaveLength(59)
        expect(useConversationStore.getState().hasMoreMap[CONV]).toBe(true)
    })

    it('evict 后 messagesMap 保留最新消息：最旧的被移除', async () => {
        addMany(85, CONV, makeHeavyToolMsg)
        await vi.advanceTimersByTimeAsync(0)

        const msgs = useConversationStore.getState().messagesMap[CONV]
        // 最旧的 25 条被移除：第一条保留的是 m-conv-bg-25
        expect(msgs[0].id).toBe('m-conv-bg-25')
        // 最新消息保留在尾部
        expect(msgs[msgs.length - 1].id).toBe('m-conv-bg-84')
        // 顺序仍是时间序（旧 → 新）
        expect(msgs.map(m => m.id)).toEqual(
            Array.from({length: 60}, (_, i) => `m-conv-bg-${i + 25}`),
        )
    })
})
