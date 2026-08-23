// @vitest-environment jsdom
/**
 * TodoStrip — 批次可见性三分支渲染测试（Task 5）
 *
 * 覆盖需求：TodoStrip 仅显示「当前活跃批次且有非终态任务」：
 * - 显示分支：currentBatch.status === 'active' + 存在非终态任务 → 渲染表头
 * - 完成隐藏：全部任务到达终态（completed/failed/error/success）→ null
 * - 无数据隐藏：无 currentBatch（且水合未命中）→ null，并触发 hydrateActiveBatch
 *
 * Mock 策略：agentStore/conversationStore 以可变 state 对象 mock，
 * 各用例改写 state 后重渲（与 ModelSelector.test.tsx 同源约定）。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'
import {render, screen} from '@testing-library/react'

const h = vi.hoisted(() => {
    const state = {
        activeConversationId: 'conv-1',
        convData: undefined as any,
        hydrateActiveBatch: vi.fn(),
    }
    return state
})

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: any) => selector({activeConversationId: h.activeConversationId}),
}))
vi.mock('@/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: any) => selector({
        convAgentStates: {[h.activeConversationId]: h.convData},
        hydrateActiveBatch: h.hydrateActiveBatch,
    }),
}))

import TodoStrip from '../../../src/renderer/components/TodoStrip'

const TASKS = [
    {id: 't1', title: '任务一', status: 'completed'},
    {id: 't2', title: '任务二', status: 'running'},
    {id: 't3', title: '任务三', status: 'pending'},
]

function activeBatchConv(taskList: Array<{id: string; title: string; status: string}>) {
    return {
        tasks: taskList,
        currentBatch: {id: 'batch-1', name: '重构登录', status: 'active'},
    }
}

beforeEach(() => {
    h.hydrateActiveBatch.mockClear()
    h.convData = undefined
})

describe('TodoStrip — 活跃批次可见性三分支', () => {
    it('显示分支：活跃批次 + 非终态任务 → 渲染表头与状态计数', () => {
        h.convData = activeBatchConv(TASKS)

        render(<TodoStrip/>)

        expect(screen.getByText('待办列表')).toBeTruthy()
        // 计数仅统计当前批次（= 全部可见任务）：1 完成 / 1 进行中 / 1 待处理
        expect(screen.getByText(/1 已完成/)).toBeTruthy()
        expect(screen.getByText(/1 进行中/)).toBeTruthy()
    })

    it('完成隐藏：批次内全部任务到达终态 → 返回 null', () => {
        h.convData = activeBatchConv([
            {id: 't1', title: '任务一', status: 'completed'},
            {id: 't2', title: '任务二', status: 'failed'},
            {id: 't3', title: '任务三', status: 'error'},
            {id: 't4', title: '任务四', status: 'success'},
        ])

        const {container} = render(<TodoStrip/>)

        expect(container.querySelector('[data-name="todo-strip"]')).toBeNull()
    })

    it('完成隐藏：batchStatus 已是 completed → 即使有非终态残留也返回 null', () => {
        h.convData = {
            tasks: TASKS,
            currentBatch: {id: 'batch-1', name: '重构登录', status: 'completed'},
        }

        const {container} = render(<TodoStrip/>)

        expect(container.querySelector('[data-name="todo-strip"]')).toBeNull()
    })

    it('无数据隐藏：无 currentBatch 且无任务 → null 并触发一次水合', () => {
        h.convData = undefined

        const {container} = render(<TodoStrip/>)

        expect(container.querySelector('[data-name="todo-strip"]')).toBeNull()
        expect(h.hydrateActiveBatch).toHaveBeenCalledTimes(1)
        expect(h.hydrateActiveBatch).toHaveBeenCalledWith('conv-1')
    })

    it('有实时数据时不重复水合（已有 currentBatch 则跳过）', () => {
        h.convData = activeBatchConv(TASKS)

        render(<TodoStrip/>)

        expect(h.hydrateActiveBatch).not.toHaveBeenCalled()
    })
})
