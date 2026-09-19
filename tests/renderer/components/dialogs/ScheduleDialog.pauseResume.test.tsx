// @vitest-environment jsdom
/**
 * 定时任务 · 暂停与恢复（ui-06）
 *
 * 口径（spec「Testing Decisions」seam 1）：渲染组件、mock store，
 * 断言**用户能看到什么、点了会发生什么**；不断言组件内部 state、不断言 DOM 层级。
 *
 * 覆盖：
 * - 暂停 / 恢复成为行内一等动作，各自打到 store.pause / store.resume
 * - 暂停态同时有徽标与恢复入口（不只是徽标）
 * - 失败不静默：可读原因进入错误通道（toast）
 * - 配置态三类文案互不相同（「已暂停」≠「已禁用」）
 * - 行内不出现 cron 表达式原文，改为人话频率摘要
 * - 运行中时那个按钮真的是「停止」（走 store.stop），不再 runNow
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'
import ScheduleDialog from '../../../../src/renderer/components/dialogs/ScheduleDialog'

const store = vi.hoisted(() => ({current: {} as any}))
vi.mock('../../../../src/renderer/stores/scheduleStore', () => ({
    useScheduleStore: () => store.current,
}))
vi.mock('../../../../src/renderer/components/dialogs/ScheduleEditModal', () => ({
    ScheduleEditModal: () => <div data-name="stub-schedule-edit-modal"/>,
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
    store.current = {
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
    return store.current
}

beforeEach(() => {
    setStore()
})

describe('暂停 / 恢复', () => {
    it('启用中的任务：点击「暂停」调用 store.pause，且不去整表重取', () => {
        const state = setStore({schedules: [makeSchedule({id: 's1', enabled: true, paused: false})]})
        const {unmount} = render(<ScheduleDialog/>)
        state.loadSchedules.mockClear()

        fireEvent.click(screen.getByRole('button', {name: '暂停'}))

        expect(state.pause).toHaveBeenCalledWith('s1')
        expect(state.resume).not.toHaveBeenCalled()
        // 暂停的成功回声由主进程广播 updated 载荷就地更新，action 内不手动 loadSchedules
        expect(state.loadSchedules).not.toHaveBeenCalled()
        unmount()
    })

    it('已暂停的任务：点「恢复」调用 store.resume（而不是 pause）', () => {
        const state = setStore({schedules: [makeSchedule({id: 's1', enabled: true, paused: true})]})
        render(<ScheduleDialog/>)

        // 暂停态必须同时有徽标与恢复入口
        expect(screen.getByText('已暂停')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', {name: '恢复'}))

        expect(state.resume).toHaveBeenCalledWith('s1')
        expect(state.pause).not.toHaveBeenCalled()
    })

    it('暂停失败不静默：可读原因进入错误通道并被播报', async () => {
        const state = setStore({
            schedules: [makeSchedule({id: 's1', enabled: true, paused: false})],
            pause: vi.fn(async () => ({ok: false, error: '存储异常（update）：db closed'})),
        })
        render(<ScheduleDialog/>)

        fireEvent.click(screen.getByRole('button', {name: '暂停'}))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('暂停失败')
        expect(alert.textContent).toContain('存储异常（update）：db closed')
        expect(state.pause).toHaveBeenCalledWith('s1')
    })

    it('恢复失败不静默：原因同样进入错误通道', async () => {
        setStore({
            schedules: [makeSchedule({id: 's1', enabled: true, paused: true})],
            resume: vi.fn(async () => ({ok: false, error: '未找到定时任务'})),
        })
        render(<ScheduleDialog/>)

        fireEvent.click(screen.getByRole('button', {name: '恢复'}))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('恢复失败')
        expect(alert.textContent).toContain('未找到定时任务')
    })

    it('暂停态仍可编辑、仍可立即执行（不被状态挡住）', () => {
        const state = setStore({schedules: [makeSchedule({id: 's1', enabled: true, paused: true})]})
        render(<ScheduleDialog/>)

        const edit = screen.getByRole('button', {name: '编辑'}) as HTMLButtonElement
        const run = screen.getByRole('button', {name: '立即执行'}) as HTMLButtonElement
        expect(edit.disabled).toBe(false)
        expect(run.disabled).toBe(false)

        fireEvent.click(run)
        expect(state.runNow).toHaveBeenCalledWith('s1')
    })
})

describe('配置态文案（C3）', () => {
    it('启用 / 已暂停 / 已禁用 三类文案互不相同，暂停与禁用不只靠颜色区分', () => {
        setStore({
            schedules: [
                makeSchedule({id: 's1', name: '甲', enabled: true, paused: false}),
                makeSchedule({id: 's2', name: '乙', enabled: true, paused: true}),
                makeSchedule({id: 's3', name: '丙', enabled: false, paused: false}),
            ],
        })
        const {container} = render(<ScheduleDialog/>)

        const chips = Array.from(container.querySelectorAll('[data-name="schedule-dialog-config-chip"]'))
            .map(el => el.textContent)
        expect(chips).toEqual(['启用', '已暂停', '已禁用'])
        expect(chips[1]).not.toBe(chips[2])
    })

    it('禁用优先：enabled=false 且 paused=true 时只呈现「已禁用」，不再出现「已暂停」', () => {
        setStore({
            schedules: [makeSchedule({id: 's1', enabled: false, paused: true})],
        })
        const {container} = render(<ScheduleDialog/>)

        const chip = container.querySelector('[data-name="schedule-dialog-config-chip"]')
        expect(chip?.textContent).toBe('已禁用')
        expect(screen.getByText('已禁用')).toBeTruthy()
    })
})

describe('行内频率摘要', () => {
    it('列表行内可归类表达式出人话摘要', () => {
        setStore({schedules: [makeSchedule({id: 's1', cronExpression: '0 9 * * *'})]})
        render(<ScheduleDialog/>)

        expect(screen.getByText('每天 09:00')).toBeTruthy()
    })

    it('无法归类的表达式回显 cron 原文（2026-09-19 用户拍板）', () => {
        setStore({schedules: [makeSchedule({id: 's1', cronExpression: '0 9 1,15 * *'})]})
        render(<ScheduleDialog/>)

        expect(screen.getByText('自定义 0 9 1,15 * *')).toBeTruthy()
    })
})

describe('「停止」名实相符（§6 #12）', () => {
    it('运行中时按钮走 store.stop，不再对本地运行中的任务 runNow', async () => {
        const state = setStore({schedules: [makeSchedule({id: 's1', enabled: true})]})
        render(<ScheduleDialog/>)

        // 先点「立即执行」→ 本地进入运行中
        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '立即执行'}))
        })
        expect(state.runNow).toHaveBeenCalledTimes(1)

        // 运行中后按钮变成「停止」，点它就是 stop
        const stopButton = screen.getByRole('button', {name: '停止'})
        await act(async () => {
            fireEvent.click(stopButton)
        })
        expect(state.stop).toHaveBeenCalledWith('s1')
        expect(state.runNow).toHaveBeenCalledTimes(1)
    })
})

describe('无障碍（H6）', () => {
    it('每个纯图标按钮都有可被读出的名字', () => {
        setStore({schedules: [makeSchedule({id: 's1', enabled: true})]})
        render(<ScheduleDialog/>)

        for (const name of ['暂停', '立即执行', '编辑', '删除', '展开执行记录']) {
            expect(screen.getByRole('button', {name})).toBeTruthy()
        }
    })

    it('行本体可聚焦；展开状态由行内「执行记录」按钮声明（A6）', () => {
        setStore({schedules: [makeSchedule({id: 's1'})]})
        render(<ScheduleDialog/>)

        // 行本体无 `aria-label`（H2），可访问名由行内可见内容合成
        const row = screen.getByRole('button', {name: /^每日构建/})
        expect(row.getAttribute('tabindex')).not.toBe('-1')
        // 行本体不声明 aria-expanded（A6：行上「点=展开 / Enter=编辑」与 disclosure 语义分叉）
        expect(row.getAttribute('aria-expanded')).toBeNull()
        expect(screen.getByRole('button', {name: '展开执行记录'}).getAttribute('aria-expanded')).toBe('false')
    })
})
