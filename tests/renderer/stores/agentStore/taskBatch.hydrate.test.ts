/**
 * 任务批次渲染端状态 — 单元测试
 *
 * 覆盖需求（Task 5）：
 * - handleTasksUpdate：事件携带 batchId/batchName/batchStatus 时写入 convData.currentBatch
 *   （顶层 + convAgentStates 双路）；字段缺失时不动 currentBatch
 * - hydrateActiveBatch：从主进程 DB 水合活跃批次快照（tasks + currentBatch）
 *   ★ 竞态守卫：水合期间实时事件已写入 currentBatch → 放弃覆盖，实时数据优先
 *
 * Mock 策略：
 * - handleTasksUpdate 用 mock ctx（参考 streamCore.agentStart.providerName.test.ts）
 * - hydrateActiveBatch 走真实 zustand store（agentStore 外部依赖仅 conversationStore，
 *   mock 之；electronAPI.taskBatches stub 于模块导入前注入）
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── electronAPI stub：必须在 import agentStore 之前注入 ──
const {mockGetActive} = vi.hoisted(() => ({
    mockGetActive: vi.fn(),
}))

vi.stubGlobal('window', {
    electronAPI: {
        taskBatches: {getActive: mockGetActive},
        configRead: vi.fn(() => Promise.resolve(undefined)),
    },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    },
})

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({activeConversationId: 'conv-1'}),
    },
    recordTextBlock: vi.fn(),
    recordThinkBlock: vi.fn(),
    recordToolResultBlock: vi.fn(),
    recordToolCallBlock: vi.fn(),
    finalizeMessageDelta: vi.fn(),
    flushConversationDirty: vi.fn(),
}))

import {useAgentStore} from '@/renderer/stores/agentStore'
import {handleTasksUpdate} from '@/renderer/stores/agentStore/handlers/streamSystem'

// ═══════════════════════════════════════════════════
// handleTasksUpdate — 批次字段写入
// ═══════════════════════════════════════════════════

describe('handleTasksUpdate — currentBatch 写入', () => {
    const TASKS = [
        {id: 't1', title: '任务一', status: 'completed'},
        {id: 't2', title: '任务二', status: 'running'},
    ]

    it('携带批次三字段时写入 currentBatch（顶层 + convData 双路）', () => {
        const mockSet = vi.fn((updater: (prev: unknown) => unknown) => updater({runningToolCount: 0}))
        const mockUpdateConvData = vi.fn()

        handleTasksUpdate({
            set: mockSet,
            get: () => ({updateConvData: mockUpdateConvData, convAgentStates: {}}),
            convId: 'conv-1',
            isActiveConv: true,
            isAgentAborted: false,
            event: {
                type: 'tasks_update',
                tasks: TASKS,
                batchId: 'batch-1',
                batchName: '重构登录',
                batchStatus: 'active',
            },
        } as unknown as Parameters<typeof handleTasksUpdate>[0])

        // 顶层 patch 含 currentBatch
        const patch = mockSet.mock.calls[0][0] as (prev: unknown) => Record<string, unknown>
        expect(patch({}).currentBatch).toEqual({id: 'batch-1', name: '重构登录', status: 'active'})
        // convData 同步含 tasks + currentBatch
        expect(mockUpdateConvData).toHaveBeenCalledWith('conv-1', {
            tasks: TASKS,
            currentBatch: {id: 'batch-1', name: '重构登录', status: 'active'},
        })
    })

    it('批次字段缺失时不动 currentBatch（保留原值语义：patch 不含该键）', () => {
        const mockSet = vi.fn((updater: (prev: unknown) => unknown) => updater({runningToolCount: 0}))
        const mockUpdateConvData = vi.fn()

        handleTasksUpdate({
            set: mockSet,
            get: () => ({updateConvData: mockUpdateConvData, convAgentStates: {}}),
            convId: 'conv-1',
            isActiveConv: true,
            isAgentAborted: false,
            event: {type: 'tasks_update', tasks: TASKS},
        } as unknown as Parameters<typeof handleTasksUpdate>[0])

        const patch = mockSet.mock.calls[0][0] as (prev: unknown) => Record<string, unknown>
        expect('currentBatch' in patch({})).toBe(false)
        expect(mockUpdateConvData).toHaveBeenCalledWith('conv-1', {tasks: TASKS})
    })
})

// ═══════════════════════════════════════════════════
// hydrateActiveBatch — 水合 + 竞态守卫（真实 store）
// ═══════════════════════════════════════════════════

describe('hydrateActiveBatch — 水合与竞态守卫', () => {
    beforeEach(() => {
        mockGetActive.mockReset()
        // 重置 store 中测试会话的批次态
        useAgentStore.setState(prev => {
            const map = {...prev.convAgentStates}
            delete map['conv-h']
            return {convAgentStates: map}
        })
    })

    const ACTIVE_SNAPSHOT = {
        batch: {id: 'batch-9', name: '迁移数据库', status: 'active', createdAt: 1, completedAt: null},
        tasks: [
            {id: 't1', title: '写 migration', status: 'completed'},
            {id: 't2', title: '验证回滚', status: 'pending'},
        ],
    }

    it('水合成功：写入 tasks + currentBatch 到 convAgentStates', async () => {
        mockGetActive.mockResolvedValue(ACTIVE_SNAPSHOT)

        await useAgentStore.getState().hydrateActiveBatch('conv-h')

        const conv = useAgentStore.getState().convAgentStates['conv-h']
        expect(conv?.currentBatch).toEqual({id: 'batch-9', name: '迁移数据库', status: 'active'})
        expect(conv?.tasks).toHaveLength(2)
        expect(conv?.tasks[0]).toMatchObject({id: 't1', title: '写 migration', status: 'completed'})
    })

    it('★ 竞态守卫：实时事件已写入 currentBatch 时放弃覆盖', async () => {
        mockGetActive.mockResolvedValue(ACTIVE_SNAPSHOT)
        // 模拟水合 await 之前实时 tasks_update 先到（不同批次）
        useAgentStore.setState(prev => ({
            convAgentStates: {
                ...prev.convAgentStates,
                'conv-h': {...(prev.convAgentStates['conv-h'] ?? {}), currentBatch: {
                    id: 'batch-live', name: '实时批次', status: 'active',
                }},
            },
        }))

        await useAgentStore.getState().hydrateActiveBatch('conv-h')

        const conv = useAgentStore.getState().convAgentStates['conv-h']
        expect(conv?.currentBatch).toEqual({id: 'batch-live', name: '实时批次', status: 'active'})
        expect(conv?.tasks).toBeUndefined() // 快照未覆盖内存态
    })

    it('无活跃批次（DB 返回 null）时不写入任何状态', async () => {
        mockGetActive.mockResolvedValue(null)

        await useAgentStore.getState().hydrateActiveBatch('conv-h')

        expect(useAgentStore.getState().convAgentStates['conv-h']).toBeUndefined()
    })

    it('IPC 异常时静默不抛出', async () => {
        mockGetActive.mockRejectedValue(new Error('ipc down'))

        await expect(useAgentStore.getState().hydrateActiveBatch('conv-h')).resolves.toBeUndefined()
        expect(useAgentStore.getState().convAgentStates['conv-h']).toBeUndefined()
    })
})
