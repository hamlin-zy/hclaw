/**
 * scheduleStore 单元测试
 *
 * 覆盖：
 * - loadSchedules：mock scheduler.list → {ok:true,data} 解包 + toUI 转换
 *   （taskPrompt 从 taskArgs[0] 提取；空列表）；失败成为显式状态（error 字段）：
 *   区分「后端返回 ok:false」与「桥接缺失」，两者都不再与「一条都没有」混同
 * - create / update / delete / stop：成功 → api 调用（写操作不再整表重取，等变更广播）；失败 → 结果原样透传
 * - runNow：透传 api.runNow；api 缺失 / runNow 缺失时返回统一失败形状
 * - onChanged：载荷为可区分的 created / updated / deleted → 就地更新对应行；
 *   未知载荷、本地不存在的行 → 回退整表重取
 *
 * 隔离：scheduleStore 模块顶层直接读取 window.electronAPI.scheduler 并
 * 注册 onChanged 监听，因此必须在 import 之前注入 window（vi.hoisted），
 * 不触碰真实 IPC。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const h = vi.hoisted(() => {
    const changedHandlers: Array<(change?: unknown) => void> = []
    const scheduler: any = {
        onChanged: vi.fn((fn: (change?: unknown) => void) => { changedHandlers.push(fn) }),
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        stop: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
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
    h.scheduler.list.mockResolvedValue({ok: true, data: []})
    h.scheduler.create.mockResolvedValue({ok: true, data: rawSchedule})
    h.scheduler.update.mockResolvedValue({ok: true, data: rawSchedule})
    h.scheduler.delete.mockResolvedValue({ok: true, data: true})
    h.scheduler.stop.mockResolvedValue({ok: true, data: true})
    h.scheduler.pause.mockResolvedValue({ok: true, data: rawSchedule})
    h.scheduler.resume.mockResolvedValue({ok: true, data: rawSchedule})
    h.scheduler.runNow.mockResolvedValue({ok: true, data: true})
    useScheduleStore.setState({schedules: [], loading: false, error: null})
})

describe('loadSchedules', () => {
    it('list 返回 {ok:true,data} → schedules 正确填充 + taskPrompt 从 taskArgs[0] 提取', async () => {
        h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
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
        h.scheduler.list.mockResolvedValue({ok: true, data: [{...rawSchedule, taskArgs: []}]})
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().schedules[0].taskPrompt).toBe('')
    })

    it('taskArgs[0] 非字符串 → taskPrompt 为空字符串', async () => {
        h.scheduler.list.mockResolvedValue({ok: true, data: [{...rawSchedule, taskArgs: [123]}]})
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().schedules[0].taskPrompt).toBe('')
    })

    it('list 返回空列表 → schedules 为空数组且无错误（「一条都没有」是成功态）', async () => {
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().schedules).toEqual([])
        expect(useScheduleStore.getState().error).toBeNull()
    })

    it('list 返回 {ok:false} → error 记录后端给出的可读原因，与「一条都没有」区分', async () => {
        h.scheduler.list.mockResolvedValue({ok: false, error: '定时任务存储异常（query）：db closed'})
        await useScheduleStore.getState().loadSchedules()
        const state = useScheduleStore.getState()
        expect(state.schedules).toEqual([])
        expect(state.error).toBe('定时任务存储异常（query）：db closed')
        expect(state.loading).toBe(false)
    })

    it('list 返回 undefined（list 方法缺失）→ error 为桥接不可用，不抛错', async () => {
        h.scheduler.list.mockResolvedValue(undefined)
        await useScheduleStore.getState().loadSchedules()
        const state = useScheduleStore.getState()
        expect(state.schedules).toEqual([])
        expect(state.error).toBe('scheduler API 不可用')
    })

    it('scheduler 桥接整体缺失 → error 为桥接不可用（与后端失败同形但原因不同）', async () => {
        const original = (globalThis as any).window.electronAPI.scheduler
        ;(globalThis as any).window.electronAPI.scheduler = undefined
        try {
            await useScheduleStore.getState().loadSchedules()
            expect(useScheduleStore.getState().error).toBe('scheduler API 不可用')
        } finally {
            ;(globalThis as any).window.electronAPI.scheduler = original
        }
    })

    it('list 抛异常 → error 为异常消息，不冒泡', async () => {
        h.scheduler.list.mockRejectedValue(new Error('ipc broken'))
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().error).toBe('ipc broken')
        expect(useScheduleStore.getState().loading).toBe(false)
    })

    it('先失败后成功 → error 被清空（重试路径）', async () => {
        h.scheduler.list.mockResolvedValueOnce({ok: false, error: 'boom'})
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().error).toBe('boom')

        h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().error).toBeNull()
        expect(useScheduleStore.getState().schedules).toHaveLength(1)
    })
})

describe('create / update / delete / stop / runNow', () => {
    it('create 成功 → 调用 api.create（含默认 enabled/空 taskArgs）；不再整表重取，等变更广播就地更新', async () => {
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
        expect(r.ok).toBe(true)
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('create enabled === false 保留禁用状态', async () => {
        await useScheduleStore.getState().create({
            name: 'x', description: '', cronExpression: '',
            taskType: 'command', taskTarget: '', enabled: false,
        })
        expect(h.scheduler.create).toHaveBeenCalledWith(expect.objectContaining({enabled: false}))
    })

    it('create 失败 → 返回 error，不 reload', async () => {
        h.scheduler.create.mockResolvedValue({ok: false, error: 'bad-cron'})
        const r = await useScheduleStore.getState().create({
            name: 'x', description: '', cronExpression: '', taskType: 'agent', taskTarget: '',
        })
        expect(r).toEqual({ok: false, error: 'bad-cron'})
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('create 桥接返回 undefined → 统一失败形状，不 reload', async () => {
        h.scheduler.create.mockResolvedValue(undefined)
        const r = await useScheduleStore.getState().create({name: 'x'})
        expect(r).toEqual({ok: false, error: 'scheduler API 不可用'})
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('update 成功 → 调用 api.update(id, updates)；不再整表重取', async () => {
        await useScheduleStore.getState().update('s1', {name: 'renamed'})
        expect(h.scheduler.update).toHaveBeenCalledWith('s1', {name: 'renamed'})
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('update 失败 → 不重取（原样透传失败形状）', async () => {
        h.scheduler.update.mockResolvedValue({ok: false, error: 'x'})
        const r = await useScheduleStore.getState().update('s1', {name: 'x'})
        expect(r).toEqual({ok: false, error: 'x'})
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('delete 成功 → 调用 api.delete(id)；不再整表重取', async () => {
        await useScheduleStore.getState().delete('s1')
        expect(h.scheduler.delete).toHaveBeenCalledWith('s1')
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('delete 失败 → 不重取', async () => {
        h.scheduler.delete.mockResolvedValue({ok: false, error: 'x'})
        await useScheduleStore.getState().delete('s1')
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('stop → 只调 api.stop(scheduleId)，不整表重取（运行状态变化由主进程广播 updated 就地更新）', async () => {
        await useScheduleStore.getState().stop('s1')
        expect(h.scheduler.stop).toHaveBeenCalledWith('s1')
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('stop 成功不把 store 置成 loading（M4：后台刷新不得让列表闪一下）', async () => {
        useScheduleStore.setState({loading: false})
        await useScheduleStore.getState().stop('s1')
        expect(useScheduleStore.getState().loading).toBe(false)
    })

    it('runNow → 透传 api.runNow 结果', async () => {
        const r = await useScheduleStore.getState().runNow('s1')
        expect(h.scheduler.runNow).toHaveBeenCalledWith('s1')
        expect(r).toEqual({ok: true, data: true})
    })

    it('runNow 失败 → 透传 error', async () => {
        h.scheduler.runNow.mockResolvedValue({ok: false, error: '未找到ID为 "s1" 的定时任务。'})
        const r = await useScheduleStore.getState().runNow('s1')
        expect(r).toEqual({ok: false, error: '未找到ID为 "s1" 的定时任务。'})
    })
})

describe('runNow 兜底（api 不可用场景）', () => {
    it('scheduler api 缺失 → 返回统一失败形状', async () => {
        const original = (globalThis as any).window.electronAPI.scheduler
        ;(globalThis as any).window.electronAPI.scheduler = undefined
        try {
            const r = await useScheduleStore.getState().runNow('s1')
            expect(r).toEqual({ok: false, error: 'scheduler API 不可用'})
        } finally {
            ;(globalThis as any).window.electronAPI.scheduler = original
        }
    })

    it('api.runNow 缺失 → 返回友好错误', async () => {
        const originalRunNow = h.scheduler.runNow
        h.scheduler.runNow = undefined
        try {
            const r = await useScheduleStore.getState().runNow('s1')
            expect(r).toEqual({ok: false, error: 'scheduler.runNow 不可用'})
        } finally {
            h.scheduler.runNow = originalRunNow
        }
    })
})

describe('onChanged（模块顶层注册）', () => {
    it('模块加载时注册了 onChanged 监听', () => {
        expect(h.changedHandlers.length).toBeGreaterThanOrEqual(1)
    })
})

describe('onChanged — 变更载荷的就地更新与回退重取', () => {
    /** 触发模块顶层注册的变更回调（生产路径：preload 桥接 → 本回调） */
    const emit = (change: unknown) => h.changedHandlers[0](change)

    const seed = (rows: any[]) => useScheduleStore.setState({schedules: rows.map(r => ({
        id: r.id, name: r.name, description: '', cronExpression: '0 0 * * *', taskType: 'agent',
        taskTarget: 't', taskArgs: [], taskPrompt: '', enabled: true, paused: false,
        lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null, runCount: 0,
        createdAt: 1, updatedAt: 1, workspaceId: null,
    }))})

    beforeEach(() => {
        seed([{id: 's1', name: '旧名'}, {id: 's2', name: '另一个'}])
    })

    it('created → 就地插入那一行（头部，与整表重取的 created_at DESC 同序），不整表重取', async () => {
        emit({type: 'created', record: {...rawSchedule, id: 's3', name: '新任务', taskArgs: ['p']}})
        const rows = useScheduleStore.getState().schedules
        expect(rows.map(r => r.id)).toEqual(['s3', 's1', 's2'])
        expect(rows[0]).toMatchObject({name: '新任务', taskPrompt: 'p'})
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('created 命中已存在的行 → 就地替换（幂等，不重复插入）', () => {
        emit({type: 'created', record: {...rawSchedule, id: 's1', name: '同名新值'}})
        const rows = useScheduleStore.getState().schedules
        expect(rows.map(r => r.id)).toEqual(['s1', 's2'])
        expect(rows[0].name).toBe('同名新值')
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('updated → 只替换那一行，其它行与顺序不变，不整表重取', () => {
        emit({type: 'updated', record: {...rawSchedule, id: 's1', name: '改名后', taskArgs: ['新提示词']}})
        const rows = useScheduleStore.getState().schedules
        expect(rows.map(r => r.id)).toEqual(['s1', 's2'])
        expect(rows[0]).toMatchObject({name: '改名后', taskPrompt: '新提示词'})
        expect(rows[1].name).toBe('另一个')
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('deleted → 只移除那一行，不整表重取', () => {
        emit({type: 'deleted', id: 's1'})
        expect(useScheduleStore.getState().schedules.map(r => r.id)).toEqual(['s2'])
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('updated 指向本地不存在的行 → 回退整表重取', async () => {
        h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
        emit({type: 'updated', record: {...rawSchedule, id: '不存在'}})
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
        await vi.waitFor(() => expect(useScheduleStore.getState().schedules).toHaveLength(1))
    })

    it('deleted 指向本地不存在的行 → 回退整表重取', () => {
        emit({type: 'deleted', id: '不存在'})
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
    })

    it('未知载荷类型 → 回退整表重取', () => {
        emit({type: 'unknown-kind', record: rawSchedule})
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
    })

    it('历史无载荷广播（undefined）→ 回退整表重取', () => {
        emit(undefined)
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
    })

    it('载荷缺记录本体 → 回退整表重取', () => {
        emit({type: 'updated'})
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
    })

    it('回退重取后列表与后端一致', async () => {
        h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
        h.changedHandlers[0](undefined)
        await vi.waitFor(() => {
            expect(useScheduleStore.getState().schedules.map(r => r.id)).toEqual(['s1'])
        })
    })
})

describe('静默刷新 —— 后台路径不得让列表闪一下（M4）', () => {
    it('loadSchedules({silent:true}) 全程不置 loading', async () => {
        h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
        useScheduleStore.setState({loading: false, error: null})
        const p = useScheduleStore.getState().loadSchedules({silent: true})
        // 同步段：loading 未被置位（这正是「列表被换成加载态」的判定点）
        expect(useScheduleStore.getState().loading).toBe(false)
        await p
        expect(useScheduleStore.getState().loading).toBe(false)
        expect(useScheduleStore.getState().schedules).toHaveLength(1)
    })

    it('非静默（用户显式点「重试」）仍进 loading —— 那一次就该显示加载态', async () => {
        let loadingDuringFetch = false
        h.scheduler.list.mockImplementation(async () => {
            loadingDuringFetch = useScheduleStore.getState().loading
            return {ok: true, data: []}
        })
        await useScheduleStore.getState().loadSchedules()
        expect(loadingDuringFetch).toBe(true)
        expect(useScheduleStore.getState().loading).toBe(false)
    })

    it('广播无法就地处理 → 回退整表重取也走静默，不置 loading', async () => {
        h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
        useScheduleStore.setState({loading: false})
        h.changedHandlers[0](undefined)
        expect(useScheduleStore.getState().loading).toBe(false)
        await vi.waitFor(() => expect(useScheduleStore.getState().schedules).toHaveLength(1))
        expect(useScheduleStore.getState().loading).toBe(false)
    })
})

describe('就地更新只动那一行（M4）', () => {
    const seed = (rows: Array<{id: string; name: string}>) => useScheduleStore.setState({
        schedules: rows.map(r => ({
            id: r.id, name: r.name, description: '', cronExpression: '0 0 * * *', taskType: 'agent',
            taskTarget: 't', taskArgs: [], taskPrompt: '', enabled: true, paused: false,
            lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null, runCount: 0,
            createdAt: 1, updatedAt: 1, workspaceId: null,
        })),
    })

    it('updated 替换目标行，其余行保持同一个对象引用（列表未被整表重建）', () => {
        seed([{id: 's1', name: '旧名'}, {id: 's2', name: '另一个'}])
        const before = useScheduleStore.getState().schedules
        h.changedHandlers[0]({type: 'updated', record: {...rawSchedule, id: 's1', name: '改名后'}})
        const after = useScheduleStore.getState().schedules
        expect(after[0]).not.toBe(before[0])
        expect(after[0].name).toBe('改名后')
        // 未变化的行按引用相等 —— 它不会被重新渲染，滚动位置自然保住
        expect(after[1]).toBe(before[1])
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })

    it('运行状态广播（停止 / 立即执行）同样只换那一行', () => {
        seed([{id: 's1', name: '甲'}, {id: 's2', name: '乙'}])
        const before = useScheduleStore.getState().schedules
        h.changedHandlers[0]({type: 'updated', record: {...rawSchedule, id: 's2', lastRunStatus: 'failure'}})
        const after = useScheduleStore.getState().schedules
        expect(after[0]).toBe(before[0])
        expect(after[1].lastRunStatus).toBe('failure')
    })
})

describe('写操作成功后 store 不进入 loading（M4）', () => {
    it('启用/禁用、暂停/恢复、停止、立即执行四条路径都不整表重取、不把列表换成加载态', async () => {
        h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
        useScheduleStore.setState({loading: false, error: null})

        await useScheduleStore.getState().update('s1', {enabled: false})
        await useScheduleStore.getState().pause('s1')
        await useScheduleStore.getState().resume('s1')
        await useScheduleStore.getState().stop('s1')
        await useScheduleStore.getState().runNow('s1')

        expect(h.scheduler.list).not.toHaveBeenCalled()
        expect(useScheduleStore.getState().loading).toBe(false)
    })
})
