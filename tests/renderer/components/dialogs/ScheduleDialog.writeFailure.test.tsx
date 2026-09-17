// @vitest-environment jsdom
/**
 * 定时任务 · 写操作的失败回声与就地更新（ui-05）
 *
 * 口径（spec「Testing Decisions」seam 1）：渲染组件、mock store，
 * 断言**用户能看到什么、点了会发生什么**；不断言组件内部 state、不断言 DOM 层级。
 *
 * 覆盖：
 * - 六条写路径的失败各自有明确原因呈现（动作名 + 可读原因），且经 role="alert" 可被播报（H6）
 * - 新建 / 编辑失败：父层把失败结果原样交回弹窗（弹窗不关、表单不丢，弹窗侧断言见 ScheduleEditModal.saveFailure.test.tsx）
 * - 启用/禁用失败：开关停在真实位置（不做乐观翻转）
 * - 删除：确认框出现、含任务名与「不可撤销」、确认后才调 delete、取消不调、失败有原因
 * - M4：成功动作之后不整表闪烁（不调 loadSchedules、列表容器不被卸载、不进入 loading）
 *
 * 说明：`store.stop()` 内部原先的 `await reload()` 属 store 侧行为，在 mock store 的这一 seam
 * 观察不到，由 tests/renderer/stores/scheduleStore.test.ts（真实 store）钉住。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'
import ScheduleDialog from '../../../../src/renderer/components/dialogs/ScheduleDialog'

const h = vi.hoisted(() => ({
    store: {} as any,
    confirmOpts: [] as any[],
    confirmImpl: null as null | ((opts: any) => Promise<boolean>),
    modalProps: null as any,
}))

vi.mock('../../../../src/renderer/stores/scheduleStore', () => ({
    useScheduleStore: () => h.store,
}))

// 确认弹窗：真实实现依赖 window 事件 + 用户点击才 resolve（否则 await confirm 永久挂起）。
// 这里 mock 成「记录选项 + 由用例决定用户点了什么」。
vi.mock('../../../../src/renderer/components/ConfirmDialog', () => ({
    confirm: vi.fn(async (opts: any) => {
        h.confirmOpts.push(opts)
        return h.confirmImpl ? h.confirmImpl(opts) : false
    }),
    default: () => null,
}))

// 编辑弹窗：本文件只关心「父层怎么对待 onSave 的结果」，弹窗自身行为另有用例
vi.mock('../../../../src/renderer/components/dialogs/ScheduleEditModal', () => ({
    ScheduleEditModal: (props: any) => {
        h.modalProps = props
        return <div data-name="stub-schedule-edit-modal"/>
    },
}))

const makeSchedule = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    name: '每日构建',
    description: '',
    cronExpression: '0 9 * * *',
    taskType: 'agent',
    taskTarget: 'code-reviewer',
    taskArgs: [],
    taskPrompt: '',
    enabled: true,
    paused: false,
    lastRunAt: null,
    lastRunStatus: 'success',
    lastRunConversationId: null,
    runCount: 0,
    createdAt: 1,
    updatedAt: 1,
    workspaceId: null,
    ...over,
})

function setStore(partial: Record<string, unknown> = {}) {
    h.store = {
        schedules: [],
        loading: false,
        error: null,
        loadSchedules: vi.fn(async () => {}),
        create: vi.fn(async () => ({ok: true, data: null})),
        update: vi.fn(async () => ({ok: true, data: null})),
        delete: vi.fn(async () => ({ok: true, data: true})),
        stop: vi.fn(async () => ({ok: true, data: true})),
        pause: vi.fn(async () => ({ok: true, data: null})),
        resume: vi.fn(async () => ({ok: true, data: null})),
        runNow: vi.fn(async () => ({ok: true, data: true})),
        ...partial,
    }
    return h.store
}

beforeEach(() => {
    h.confirmOpts.length = 0
    h.confirmImpl = null
    h.modalProps = null
    setStore()
})

afterEach(() => {
    vi.useRealTimers()
})

/** 弹窗桩节点：存在 = 弹窗还开着（失败不关窗的判据） */
const modalStub = () => document.querySelector('[data-name="stub-schedule-edit-modal"]')

/** 列表行本体（不含操作按钮）——用于断言「那一行还在、没被卸载重挂」 */
const rowOf = () => screen.getByRole('button', {name: /^每日构建/})

describe('新建 / 编辑 —— 失败不关窗，结果原样交回弹窗', () => {
    it('新建失败：create 的可读原因原样返回，弹窗保持打开（表单不丢）', async () => {
        const state = setStore({
            create: vi.fn(async () => ({ok: false, error: 'cron 表达式非法：0 9 *'})),
        })
        render(<ScheduleDialog/>)

        fireEvent.click(screen.getByRole('button', {name: '新建'}))
        let result: any
        await act(async () => {
            result = await h.modalProps.onSave({
                name: '新任务', description: '', taskType: 'agent', taskTarget: 'code-reviewer',
                taskPrompt: '', cronExpression: '0 9 *', enabled: true, workspaceId: null,
            })
        })

        expect(state.create).toHaveBeenCalledTimes(1)
        expect(result).toEqual({ok: false, error: 'cron 表达式非法：0 9 *'})
        // 失败不关窗：弹窗仍在
        expect(modalStub()).toBeTruthy()
    })

    it('编辑失败：update 的可读原因原样返回，弹窗保持打开', async () => {
        const state = setStore({
            schedules: [makeSchedule()],
            update: vi.fn(async () => ({ok: false, error: '未找到ID为 "s1" 的定时任务。'})),
        })
        render(<ScheduleDialog/>)

        fireEvent.click(screen.getByRole('button', {name: '编辑'}))
        let result: any
        await act(async () => {
            result = await h.modalProps.onSave({
                id: 's1', name: '改个名', description: '', taskType: 'agent', taskTarget: 'code-reviewer',
                taskPrompt: '', cronExpression: '0 9 * * *', enabled: true, workspaceId: null,
            })
        })

        expect(state.update).toHaveBeenCalledWith('s1', expect.objectContaining({name: '改个名'}))
        expect(result).toEqual({ok: false, error: '未找到ID为 "s1" 的定时任务。'})
        expect(modalStub()).toBeTruthy()
    })

    it('新建成功：父层关窗（成功之后弹窗不再挡着列表）', async () => {
        setStore({create: vi.fn(async () => ({ok: true, data: makeSchedule()}))})
        render(<ScheduleDialog/>)

        fireEvent.click(screen.getByRole('button', {name: '新建'}))
        await act(async () => {
            await h.modalProps.onSave({
                name: '新任务', description: '', taskType: 'agent', taskTarget: 'code-reviewer',
                taskPrompt: '', cronExpression: '0 9 * * *', enabled: true, workspaceId: null,
            })
        })

        expect(modalStub()).toBeNull()
    })

    it('create 抛异常（桥接层炸了）→ 也回一个可读失败，不冒泡给弹窗', async () => {
        setStore({create: vi.fn(async () => { throw new Error('ipc broken') })})
        render(<ScheduleDialog/>)

        fireEvent.click(screen.getByRole('button', {name: '新建'}))
        let result: any
        await act(async () => {
            result = await h.modalProps.onSave({
                name: 'x', description: '', taskType: 'agent', taskTarget: 't',
                taskPrompt: '', cronExpression: '0 9 * * *', enabled: true, workspaceId: null,
            })
        })
        expect(result).toEqual({ok: false, error: 'ipc broken'})
    })
})

describe('启用 / 禁用 —— 失败有声，开关回到真实状态', () => {
    it('禁用失败：开关停在原位（不做乐观翻转）+ 可读原因经 alert 播报', async () => {
        const state = setStore({
            schedules: [makeSchedule({enabled: true})],
            update: vi.fn(async () => ({ok: false, error: '存储异常（update）：db closed'})),
        })
        render(<ScheduleDialog/>)

        const sw = screen.getByRole('switch', {name: '禁用'})
        expect(sw.getAttribute('aria-checked')).toBe('true')

        await act(async () => {
            fireEvent.click(sw)
        })

        expect(state.update).toHaveBeenCalledWith('s1', {enabled: false})
        // 真实状态仍是「已启用」——开关没有被本地乐观改成关闭
        expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('禁用失败')
        expect(alert.textContent).toContain('存储异常（update）：db closed')
    })

    it('启用失败：同样是「启用失败：<原因>」', async () => {
        setStore({
            schedules: [makeSchedule({enabled: false})],
            update: vi.fn(async () => ({ok: false, error: '未找到定时任务'})),
        })
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('switch', {name: '启用'}))
        })

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('启用失败')
        expect(alert.textContent).toContain('未找到定时任务')
        expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    })

    it('启用成功：开关回到真实状态（由真数据驱动）', async () => {
        setStore({schedules: [makeSchedule({enabled: false})]})
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('switch', {name: '启用'}))
        })
        // mock store 不写回真数据，故仍显示真实值 false —— 正说明没有本地乐观翻转
        expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
        expect(screen.queryByRole('alert')).toBeNull()
    })
})

describe('删除 —— 有确认、告知不可撤销、失败有原因', () => {
    it('出现确认框，文案含任务名与「不可撤销」；用户确认后才调 delete', async () => {
        const state = setStore({schedules: [makeSchedule({name: '每日构建'})]})
        h.confirmImpl = async (opts) => {
            await opts.onConfirm()
            return true
        }
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '删除'}))
        })

        expect(h.confirmOpts).toHaveLength(1)
        expect(h.confirmOpts[0].message).toContain('每日构建')
        expect(h.confirmOpts[0].message).toContain('不可撤销')
        expect(h.confirmOpts[0].confirmVariant).toBe('danger')
        expect(state.delete).toHaveBeenCalledWith('s1')
    })

    it('用户取消 → 不调 delete', async () => {
        const state = setStore({schedules: [makeSchedule()]})
        h.confirmImpl = async () => false
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '删除'}))
        })

        expect(h.confirmOpts).toHaveLength(1)
        expect(state.delete).not.toHaveBeenCalled()
    })

    it('删除失败：原因进入可播报的错误通道', async () => {
        setStore({
            schedules: [makeSchedule()],
            delete: vi.fn(async () => ({ok: false, error: '未找到ID为 "s1" 的定时任务。'})),
        })
        h.confirmImpl = async (opts) => {
            await opts.onConfirm()
            return true
        }
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '删除'}))
        })

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('删除失败')
        expect(alert.textContent).toContain('未找到ID为 "s1" 的定时任务。')
    })

    it('删除抛异常（桥接层炸了）→ 同样有可读回声，不逃成未处理的 rejection', async () => {
        setStore({
            schedules: [makeSchedule()],
            delete: vi.fn(async () => { throw new Error('ipc broken') }),
        })
        h.confirmImpl = async (opts) => {
            await opts.onConfirm()
            return true
        }
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '删除'}))
        })

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('删除失败')
        expect(alert.textContent).toContain('ipc broken')
    })
})

describe('暂停 / 恢复 / 立即执行 / 停止 —— 失败回声与可播报', () => {
    it('暂停失败：原因可读且可被读屏播报', async () => {
        setStore({
            schedules: [makeSchedule({paused: false})],
            pause: vi.fn(async () => ({ok: false, error: '存储异常（update）：db closed'})),
        })
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '暂停'}))
        })

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('暂停失败')
        expect(alert.textContent).toContain('存储异常（update）：db closed')
    })

    it('立即执行失败：原因可读且可被读屏播报', async () => {
        setStore({
            schedules: [makeSchedule()],
            runNow: vi.fn(async () => ({ok: false, error: 'Schedule not found'})),
        })
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('立即执行失败')
        expect(alert.textContent).toContain('Schedule not found')
    })

    it('停止失败：原因可读且可被读屏播报（按钮名实相符，走 store.stop）', async () => {
        const state = setStore({
            schedules: [makeSchedule({lastRunStatus: 'running'})],
            stop: vi.fn(async () => ({ok: false, error: '任务不在运行中'})),
        })
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })
        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '停止'}))
        })

        expect(state.stop).toHaveBeenCalledWith('s1')
        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('停止失败')
        expect(alert.textContent).toContain('任务不在运行中')
    })

    it('停止抛异常（桥接层炸了）→ 同样有可读回声，不逃成未处理的 rejection', async () => {
        // lastRunStatus 非 running：避开「后端残留 running 的补扫」那条路，
        // 让本次点击只走「停止」这一条（补扫路径另有用例）。
        const state = setStore({
            schedules: [makeSchedule()],
            stop: vi.fn(async () => { throw new Error('ipc broken') }),
        })
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '停止'}))
        })

        expect(state.stop).toHaveBeenCalledTimes(1)
        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('停止失败')
        expect(alert.textContent).toContain('ipc broken')
    })

    it('后端残留 running 的补扫：stop 抛异常仍先回声，且不中断后续的 runNow', async () => {
        // 行为放宽的护栏（原为异常逃逸 → runNow 不调用）：
        // 后端仍残留 running 时「立即执行」会先 stop 清理后端状态再启动；
        // stop 抛异常**不再**中断这条链路——先给出可读回声，再照常补刷并启动。
        const state = setStore({
            schedules: [makeSchedule({lastRunStatus: 'running'})],
            stop: vi.fn(async () => { throw new Error('ipc broken') }),
        })
        render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })

        // ① 异常不逃逸：留下可读回声（否则用户只看到「点了没反应」）
        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('停止失败')
        expect(alert.textContent).toContain('ipc broken')
        // ② 异常不中断补扫：静默补刷一次，且照常进入立即执行
        expect(state.loadSchedules).toHaveBeenCalledWith({silent: true})
        expect(state.runNow).toHaveBeenCalledWith('s1')
    })

    it('失败提示都落在 live region 上（role="alert"），不是普通文字块', async () => {        setStore({
            schedules: [makeSchedule()],
            runNow: vi.fn(async () => ({ok: false, error: 'boom'})),
        })
        const {container} = render(<ScheduleDialog/>)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })

        const alert = await screen.findByRole('alert')
        expect(container.contains(alert)).toBe(true)
        expect(alert.textContent).toContain('立即执行失败：boom')
    })
})

describe('M4 · 成功动作之后不整表闪烁、不丢滚动位置', () => {
    it('启用/禁用：不触发整表重取，那一行仍是同一个节点（容器未被卸载）', async () => {
        const state = setStore({schedules: [makeSchedule()]})
        render(<ScheduleDialog/>)
        state.loadSchedules.mockClear()
        const before = rowOf()

        await act(async () => {
            fireEvent.click(screen.getByRole('switch', {name: '禁用'}))
        })

        expect(state.loadSchedules).not.toHaveBeenCalled()
        expect(screen.queryByText('加载中...')).toBeNull()
        expect(rowOf()).toBe(before)
    })

    it('暂停/恢复：不触发整表重取，那一行仍是同一个节点', async () => {
        const state = setStore({schedules: [makeSchedule({paused: false})]})
        render(<ScheduleDialog/>)
        state.loadSchedules.mockClear()
        const before = rowOf()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '暂停'}))
        })

        expect(state.pause).toHaveBeenCalledWith('s1')
        expect(state.loadSchedules).not.toHaveBeenCalled()
        expect(screen.queryByText('加载中...')).toBeNull()
        expect(rowOf()).toBe(before)
    })

    it('停止：不触发整表重取，那一行仍是同一个节点', async () => {
        const state = setStore({schedules: [makeSchedule()]})
        render(<ScheduleDialog/>)
        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })
        state.loadSchedules.mockClear()
        const before = rowOf()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '停止'}))
        })

        expect(state.stop).toHaveBeenCalledWith('s1')
        expect(state.loadSchedules).not.toHaveBeenCalled()
        expect(screen.queryByText('加载中...')).toBeNull()
        expect(rowOf()).toBe(before)
    })

    it('立即执行：2s 后的收尾定时器只清本地「运行中」，不再整表重取', async () => {
        vi.useFakeTimers()
        const state = setStore({schedules: [makeSchedule()]})
        render(<ScheduleDialog/>)
        state.loadSchedules.mockClear()
        const before = rowOf()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })
        expect(state.runNow).toHaveBeenCalledWith('s1')

        await act(async () => {
            vi.advanceTimersByTime(2100)
        })

        expect(state.loadSchedules).not.toHaveBeenCalled()
        expect(screen.queryByText('加载中...')).toBeNull()
        expect(rowOf()).toBe(before)
        // 定时器仍要生效：本地「运行中」标记已复位，按钮回到「立即执行」
        expect(screen.getByRole('button', {name: '立即执行'})).toBeTruthy()
    })

    it('运行状态由广播就地更新时列表不重取（后端残留 running 的补扫也走静默）', async () => {
        const state = setStore({schedules: [makeSchedule({lastRunStatus: 'running'})]})
        render(<ScheduleDialog/>)
        state.loadSchedules.mockClear()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })

        // 补扫如果不是静默，就会在这里被观察到（本用例只钉「调用形状」）
        for (const call of state.loadSchedules.mock.calls) {
            expect(call[0]).toEqual({silent: true})
        }
    })
})
