/**
 * scheduleStore 单元测试
 *
 * 覆盖：
 * - loadSchedules：mock scheduler.list → schedules 填充 + toUI 转换
 *   （taskPrompt 从 taskArgs[0] 提取；空列表）
 * - create / update / delete：成功 → api 调用 + reload；失败 → 不 reload
 * - stop：调用 api.stop + reload
 * - runNow：透传 api.runNow；api 缺失 / runNow 缺失时返回友好错误
 * - onChanged：模块顶层注册的监听触发 loadSchedules 刷新
 *
 * 隔离：scheduleStore 模块顶层直接读取 window.electronAPI.scheduler 并
 * 注册 onChanged 监听，因此必须在 import 之前注入 window（vi.hoisted），
 * 不触碰真实 IPC。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const h = vi.hoisted(() => {
    const changedHandlers: Array<() => void> = []
    const scheduler: any = {
        onChanged: vi.fn((fn: () => void) => { changedHandlers.push(fn) }),
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        stop: vi.fn(),
        runNow: vi.fn(),
    }
    ;(globalThis as any).window = {electronAPI: {scheduler}}
    return {scheduler, changedHandlers}
})

import {useScheduleStore} from '@/renderer/stores/scheduleStore'

/** 后端原始定时任务记录（taskArgs[0] 为 prompt） */
const rawSchedule = {
    id: 's1',
    name: '每日备份',
    description: 'desc',
    cronExpression: '0 0 * * *',
    taskType: 'agent',
    taskTarget: 'backup',
    taskArgs: ['把工作区备份到指定目录', 'extra'],
    enabled: true,
    paused: false,
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunConversationId: null,
    runCount: 0,
    createdAt: 100,
    updatedAt: 200,
}

beforeEach(() => {
    vi.clearAllMocks()
    h.scheduler.list.mockResolvedValue([])
    h.scheduler.create.mockResolvedValue({success: true})
    h.scheduler.update.mockResolvedValue({success: true})
    h.scheduler.delete.mockResolvedValue({success: true})
    h.scheduler.stop.mockResolvedValue(undefined)
    h.scheduler.runNow.mockResolvedValue({success: true})
    useScheduleStore.setState({schedules: [], loading: false})
})

describe('loadSchedules', () => {
    it('list 返回列表 → schedules 正确填充 + taskPrompt 从 taskArgs[0] 提取', async () => {
        h.scheduler.list.mockResolvedValue([rawSchedule])
        await useScheduleStore.getState().loadSchedules()
        const state = useScheduleStore.getState()
        expect(state.loading).toBe(false)
        expect(state.schedules).toHaveLength(1)
        expect(state.schedules[0]).toMatchObject({
            id: 's1',
            name: '每日备份',
            cronExpression: '0 0 * * *',
            taskType: 'agent',
            taskTarget: 'backup',
            taskArgs: ['把工作区备份到指定目录', 'extra'],
            taskPrompt: '把工作区备份到指定目录',
            enabled: true,
            paused: false,
            workspaceId: null,
        })
    })

    it('taskArgs 为空 → taskPrompt 为空字符串', async () => {
        h.scheduler.list.mockResolvedValue([{...rawSchedule, taskArgs: []}])
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().schedules[0].taskPrompt).toBe('')
    })

    it('taskArgs[0] 非字符串 → taskPrompt 为空字符串', async () => {
        h.scheduler.list.mockResolvedValue([{...rawSchedule, taskArgs: [123]}])
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().schedules[0].taskPrompt).toBe('')
    })

    it('list 返回空列表 → schedules 为空数组', async () => {
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().schedules).toEqual([])
    })
})

describe('create / update / delete / stop / runNow', () => {
    it('create 成功 → 调用 api.create（含默认 enabled/空 taskArgs） + reload', async () => {
        h.scheduler.list.mockResolvedValue([rawSchedule])
        const r = await useScheduleStore.getState().create({
            name: '新任务', description: 'd', cronExpression: '* * * * *',
            taskType: 'skill', taskTarget: 't',
        })
        expect(h.scheduler.create).toHaveBeenCalledWith({
            name: '新任务',
            description: 'd',
            cronExpression: '* * * * *',
            taskType: 'skill',
            taskTarget: 't',
            taskArgs: [],
            enabled: true,
            workspaceId: null,
        })
        expect(r).toEqual({success: true})
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
        expect(useScheduleStore.getState().schedules).toHaveLength(1)
    })

    it('create enabled === false 保留禁用状态', async () => {
        await useScheduleStore.getState().create({
            name: 'x', description: '', cronExpression: '',
            taskType: 'command', taskTarget: '', enabled: false,
        })
        expect(h.scheduler.create).toHaveBeenCalledWith(expect.objectContaining({enabled: false}))
    })

    it('create 失败 → 返回 error，不 reload', async () => {
        h.scheduler.create.mockResolvedValue({success: false, error: 'bad-cron'})
        const r = await useScheduleStore.getState().create({
            name: 'x', description: '', cronExpression: '', taskType: 'agent', taskTarget: '',
        })
        expect(r).toEqual({success: false, error: 'bad-cron'})
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('update 成功 → 调用 api.update(id, updates) + reload', async () => {
        h.scheduler.update.mockResolvedValue({success: true})
        h.scheduler.list.mockResolvedValue([])
        await useScheduleStore.getState().update('s1', {name: 'renamed'})
        expect(h.scheduler.update).toHaveBeenCalledWith('s1', {name: 'renamed'})
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
    })

    it('update 失败 → 不 reload', async () => {
        h.scheduler.update.mockResolvedValue({success: false, error: 'x'})
        await useScheduleStore.getState().update('s1', {name: 'x'})
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('delete 成功 → 调用 api.delete(id) + reload', async () => {
        h.scheduler.delete.mockResolvedValue({success: true})
        h.scheduler.list.mockResolvedValue([])
        await useScheduleStore.getState().delete('s1')
        expect(h.scheduler.delete).toHaveBeenCalledWith('s1')
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
    })

    it('delete 失败 → 不 reload', async () => {
        h.scheduler.delete.mockResolvedValue({success: false, error: 'x'})
        await useScheduleStore.getState().delete('s1')
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('stop → 调用 api.stop(scheduleId) + reload', async () => {
        h.scheduler.list.mockResolvedValue([])
        await useScheduleStore.getState().stop('s1')
        expect(h.scheduler.stop).toHaveBeenCalledWith('s1')
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
    })

    it('runNow → 透传 api.runNow 结果', async () => {
        h.scheduler.runNow.mockResolvedValue({success: true})
        const r = await useScheduleStore.getState().runNow('s1')
        expect(h.scheduler.runNow).toHaveBeenCalledWith('s1')
        expect(r).toEqual({success: true})
    })

    it('runNow 返回 void（runNow 存在但不返回）→ 透传 undefined', async () => {
        h.scheduler.runNow.mockResolvedValue(undefined)
        const r = await useScheduleStore.getState().runNow('s1')
        expect(r).toBeUndefined()
    })
})

describe('runNow 兜底（api 不可用场景）', () => {
    it('scheduler api 缺失 → 返回友好错误', async () => {
        const original = (globalThis as any).window.electronAPI.scheduler
        ;(globalThis as any).window.electronAPI.scheduler = undefined
        try {
            const r = await useScheduleStore.getState().runNow('s1')
            expect(r).toEqual({success: false, error: 'scheduler API 不可用'})
        } finally {
            ;(globalThis as any).window.electronAPI.scheduler = original
        }
    })

    it('api.runNow 缺失 → 返回友好错误', async () => {
        const originalRunNow = h.scheduler.runNow
        h.scheduler.runNow = undefined
        try {
            const r = await useScheduleStore.getState().runNow('s1')
            expect(r).toEqual({success: false, error: 'scheduler.runNow 不可用'})
        } finally {
            h.scheduler.runNow = originalRunNow
        }
    })
})

describe('onChanged（模块顶层注册）', () => {
    it('模块加载时注册了 onChanged 监听', () => {
        expect(h.changedHandlers.length).toBeGreaterThanOrEqual(1)
    })

    it('触发 onChanged → 刷新 schedules', async () => {
        h.scheduler.list.mockResolvedValue([rawSchedule])
        h.changedHandlers[0]()
        await vi.waitFor(() => {
            expect(useScheduleStore.getState().schedules).toHaveLength(1)
        })
        expect(h.scheduler.list).toHaveBeenCalled()
    })
})
