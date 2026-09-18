/**
 * scheduleStore · 工作目录健康度（票 11 · workspace-guard）
 *
 * 三条口径：
 *   1. 健康度与列表**同源同时**取回：列表刷新一次就刷新一次，界面上的可用性与刚取回的任务对得上；
 *   2. 配置变更广播到达时就地更新那一行**并**重拉健康度 —— 用户把工作目录改回有效值后，
 *      标记应当立刻消失，不需要手动刷新，也不整表 loading（M4）；
 *   3. 只有这两个时机，**没有轮询定时器**（停在那儿看着时间流逝，不该产生任何取数）。
 *
 * 隔离：沿用 scheduleStore.test.ts 的手法 —— 模块顶层就读 window.electronAPI.scheduler
 * 并注册 onChanged，故 window 必须在 import 之前注入（vi.hoisted）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

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
        workspaceHealth: vi.fn(),
    }
    ;(globalThis as any).window = {electronAPI: {scheduler}}
    return {scheduler, changedHandlers}
})

import {useScheduleStore} from '@/renderer/stores/scheduleStore'

const rawSchedule = {
    id: 's1',
    name: '每日备份',
    description: '',
    cronExpression: '0 0 * * *',
    taskType: 'agent',
    taskTarget: 'backup',
    taskArgs: [],
    enabled: true,
    paused: false,
    lastRunAt: null,
    lastRunStatus: 'none',
    lastRunConversationId: null,
    runCount: 0,
    createdAt: 100,
    updatedAt: 200,
    workspaceId: 'ws-dead',
}

const MISSING = {state: 'missing' as const, path: null, reason: '工作目录已不存在'}
const OK = {state: 'ok' as const, path: 'E:/ws2', reason: null}

beforeEach(() => {
    vi.clearAllMocks()
    h.scheduler.list.mockResolvedValue({ok: true, data: [rawSchedule]})
    h.scheduler.workspaceHealth.mockResolvedValue({ok: true, data: {s1: MISSING}})
    useScheduleStore.setState({schedules: [], loading: false, error: null, workspaceHealth: {}})
})

afterEach(() => {
    vi.useRealTimers()
})

describe('健康度随列表一起取回', () => {
    it('loadSchedules 之后，每个任务都有健康度可用', async () => {
        await useScheduleStore.getState().loadSchedules()

        const state = useScheduleStore.getState()
        expect(state.schedules).toHaveLength(1)
        expect(state.workspaceHealth.s1).toEqual(MISSING)
        expect(h.scheduler.workspaceHealth).toHaveBeenCalledTimes(1)
    })

    it('健康度取数失败（{ok:false} / 桥接缺失）不炸、不伪造结论：标记表保持为空', async () => {
        h.scheduler.workspaceHealth.mockResolvedValue({ok: false, error: 'db closed'})
        await useScheduleStore.getState().loadSchedules()
        expect(useScheduleStore.getState().workspaceHealth).toEqual({})
        expect(useScheduleStore.getState().schedules).toHaveLength(1)
    })
})

describe('配置变更广播 → 就该行重算可用性（M4）', () => {
    it('收到 updated 后：那一行就地更新，且健康度重拉（改成有效目录后标记即消失）', async () => {
        await useScheduleStore.getState().loadSchedules()
        useScheduleStore.setState({loading: false})
        h.scheduler.workspaceHealth.mockClear()

        // 用户把工作目录改成了 ws-2（有效），主进程广播更新后的记录
        h.scheduler.list.mockResolvedValue({ok: true, data: [{...rawSchedule, workspaceId: 'ws-2'}]})
        h.scheduler.workspaceHealth.mockResolvedValue({ok: true, data: {s1: OK}})
        h.changedHandlers[0]({type: 'updated', record: {...rawSchedule, workspaceId: 'ws-2'}})

        await vi.waitFor(() => {
            expect(useScheduleStore.getState().workspaceHealth.s1).toEqual(OK)
        })
        expect(useScheduleStore.getState().schedules[0].workspaceId).toBe('ws-2')
        // 就地更新：没有整表重取（不闪、不重置滚动位置）
        expect(h.scheduler.list).toHaveBeenCalledTimes(1)
        expect(useScheduleStore.getState().loading).toBe(false)
    })

    it('收到 created / deleted 同样补一次健康度取数（否则新行没有可用性可言）', async () => {
        await useScheduleStore.getState().loadSchedules()
        h.scheduler.workspaceHealth.mockClear()

        h.changedHandlers[0]({type: 'deleted', id: 's1'})
        await vi.waitFor(() => expect(h.scheduler.workspaceHealth).toHaveBeenCalledTimes(1))
        expect(useScheduleStore.getState().schedules).toEqual([])
    })
})

describe('不新增轮询定时器', () => {
    it('静置两分钟：不再产生任何健康度取数', async () => {
        vi.useFakeTimers()
        await useScheduleStore.getState().loadSchedules()
        h.scheduler.workspaceHealth.mockClear()
        h.scheduler.list.mockClear()

        vi.advanceTimersByTime(120_000)

        expect(h.scheduler.workspaceHealth).not.toHaveBeenCalled()
        expect(h.scheduler.list).not.toHaveBeenCalled()
    })
})

/**
 * 复核 S5（渲染层侧）：广播驱动的健康度刷新要有**短合并窗口**。
 * 一次运行会广播 1~2 次，K 个任务被拦就是 K 次广播；每次都拉一遍健康度的话，
 * 主进程那边是 K 次 sweep（每次 M 个 stat）。合并窗口内的多条广播只换一次取数。
 */
describe('广播驱动的健康度刷新有合并窗口（S5）', () => {
    it('一阵连续广播只换一次取数，且窗口过后取数确实发生（不是把刷新吞掉）', async () => {
        vi.useFakeTimers()
        await useScheduleStore.getState().loadSchedules()
        h.scheduler.workspaceHealth.mockClear()

        // 同一次运行引发的多条广播（运行中 → 成功/失败，多条任务被拦）
        for (let i = 0; i < 5; i++) {
            h.changedHandlers[0]({type: 'updated', record: {...rawSchedule, runCount: i}})
        }

        // 窗口未到：还没有取数（合并中）
        await vi.advanceTimersByTimeAsync(50)
        expect(h.scheduler.workspaceHealth).not.toHaveBeenCalled()

        // 窗口过后：恰好一次
        await vi.advanceTimersByTimeAsync(200)
        expect(h.scheduler.workspaceHealth).toHaveBeenCalledTimes(1)
        expect(useScheduleStore.getState().schedules[0].runCount).toBe(4)
    })

    it('窗口过后的下一阵广播会重新触发取数（合并窗口不会永久关闸）', async () => {
        vi.useFakeTimers()
        await useScheduleStore.getState().loadSchedules()
        h.scheduler.workspaceHealth.mockClear()

        h.changedHandlers[0]({type: 'updated', record: {...rawSchedule, runCount: 1}})
        await vi.advanceTimersByTimeAsync(300)
        expect(h.scheduler.workspaceHealth).toHaveBeenCalledTimes(1)

        h.changedHandlers[0]({type: 'updated', record: {...rawSchedule, runCount: 2}})
        await vi.advanceTimersByTimeAsync(300)
        expect(h.scheduler.workspaceHealth).toHaveBeenCalledTimes(2)
    })
})
