import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── 依赖 mock：conversationStore 用 hoisted 状态（工厂被提升，必须 hoisted 引用） ──
const {mockState, mockActiveConvId, mockUpdateMessageForConv} = vi.hoisted(() => {
    return {
        mockState: {
            activeConversationId: 'conv-root',
        },
        mockActiveConvId: {
            get value(): string {
                return mockState.activeConversationId
            },
            set value(v: string) {
                mockState.activeConversationId = v
            },
        },
        mockUpdateMessageForConv: vi.fn(),
    }
})

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            activeConversationId: mockState.activeConversationId,
            updateMessageForConv: mockUpdateMessageForConv,
        }),
    },
}))

// 被测模块
import {handleTasksUpdate} from '@/renderer/stores/agentStore/handlers/streamSystem'
import type {StreamCtx} from '@/renderer/stores/agentStore/handlers/streamContext'

// 构造 StreamCtx 的 set/get
function makeCtx(convId: string, activeConvId: string, existingConvData: Record<string, unknown> = {}) {
    mockState.activeConversationId = activeConvId

    const storeState: any = {
        tasks: [],
        agentState: {status: 'running', mode: 'auto', phase: 'streaming'},
        runningToolCount: 0,
        isThinkingAfterTools: true,
        streamingMessageId: 'msg-1',
        convAgentStates: {
            [convId]: {
                agentState: {status: 'running', mode: 'auto', phase: 'streaming'},
                streamingMessageId: 'msg-1',
                runningToolCount: 0,
                tasks: [],
                ...existingConvData,
            },
        },
    }

    // 模拟 updateConvData：更新 convAgentStates，若 convId === active 则同步顶层
    // ★ 从 mockState.activeConversationId 读实时激活会话（切换后立即生效）
    const updateConvData = (id: string, updates: Record<string, unknown>) => {
        const prev = storeState.convAgentStates[id] || {}
        const newData = {...prev, ...updates}
        storeState.convAgentStates[id] = newData
        if (id === mockState.activeConversationId) {
            storeState.tasks = newData.tasks
        }
    }

    const get = () => storeState
    const set = (fn: (prev: any) => any) => {
        const next = fn(storeState)
        Object.assign(storeState, next)
    }

    const ctx: StreamCtx = {
        set,
        get,
        convId,
        isActiveConv: convId === activeConvId,
        isAgentAborted: false,
        event: {type: 'tasks_update', tasks: []},
    }
    return {ctx, storeState, updateConvData}
}

describe('handleTasksUpdate — 待办列表按会话路由', () => {
    beforeEach(() => {
        mockUpdateMessageForConv.mockClear()
    })

    it('激活会话的任务更新同步到顶层 tasks（UI 显示跟随）', () => {
        const {ctx, storeState, updateConvData} = makeCtx('conv-root', 'conv-root')
        // 被测函数内部调用 get().updateConvData，需要把 updateConvData 挂到 storeState 上
        ;(storeState as any).updateConvData = updateConvData
        ctx.event = {type: 'tasks_update', tasks: [{id: 't1', title: '任务A', status: 'pending'}]}

        handleTasksUpdate(ctx)

        expect(storeState.convAgentStates['conv-root'].tasks).toHaveLength(1)
        expect(storeState.tasks).toHaveLength(1)
        expect(mockUpdateMessageForConv).toHaveBeenCalled()
    })

    it('非激活会话（后台子会话）的任务更新不污染顶层 tasks', () => {
        const {ctx, storeState, updateConvData} = makeCtx('conv-child', 'conv-root')
        ;(storeState as any).updateConvData = updateConvData
        ctx.event = {type: 'tasks_update', tasks: [{id: 't-child', title: '子会话任务', status: 'pending'}]}

        handleTasksUpdate(ctx)

        // 子会话的 tasks 只写入 convAgentStates['conv-child']
        expect(storeState.convAgentStates['conv-child'].tasks).toHaveLength(1)
        // 顶层 tasks 不被污染（仍为空/当前激活会话的值）
        expect(storeState.tasks).toHaveLength(0)
        // 激活会话的 convAgentStates 不被污染
        expect(storeState.convAgentStates['conv-root']?.tasks ?? []).toHaveLength(0)
    })

    it('切换到子会话后，子会话任务同步到顶层（切换跟随）', () => {
        const {ctx, storeState, updateConvData} = makeCtx('conv-child', 'conv-root')
        ;(storeState as any).updateConvData = updateConvData
        ctx.event = {type: 'tasks_update', tasks: [{id: 't-child', title: '子会话任务', status: 'pending'}]}
        handleTasksUpdate(ctx)

        // 模拟用户切换到子会话：activeConversationId 变为 conv-child
        mockState.activeConversationId = 'conv-child'
        updateConvData('conv-child', {})

        expect(storeState.tasks).toHaveLength(1)
        expect(storeState.tasks[0].title).toBe('子会话任务')
    })

    it('任务全部完成且无运行中工具时，agentState 置为 idle', () => {
        const {ctx, storeState, updateConvData} = makeCtx('conv-root', 'conv-root')
        ;(storeState as any).updateConvData = updateConvData
        ctx.event = {
            type: 'tasks_update',
            tasks: [
                {id: 't1', title: '任务A', status: 'completed'},
                {id: 't2', title: '任务B', status: 'failed'},
            ],
        }

        handleTasksUpdate(ctx)

        expect(storeState.agentState.status).toBe('idle')
        expect(storeState.streamingMessageId).toBeNull()
    })
})
