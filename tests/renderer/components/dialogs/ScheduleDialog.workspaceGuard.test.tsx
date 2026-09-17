// @vitest-environment jsdom
/**
 * 定时任务列表 · 工作目录失效的端到端接线（票 11 · workspace-guard）
 *
 * 单测过的两个零件（store 的健康度、卡片的标记与禁用）在这里接起来验一次：
 * 列表渲染的可用性完全来自 store 里的健康度，改成有效工作目录后（store 重算 → 行重渲染）
 * 标记消失、按钮恢复可点 —— 不需要用户做任何额外动作。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen} from '@testing-library/react'
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
    workspaceId: 'ws-dead',
    ...over,
})

function setStore(partial: Record<string, unknown> = {}) {
    store.current = {
        schedules: [],
        loading: false,
        error: null,
        workspaceHealth: {},
        loadSchedules: vi.fn(async () => {}),
        loadWorkspaceHealth: vi.fn(async () => {}),
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

const chip = () => document.querySelector('[data-name="schedule-dialog-workspace-chip"]')
const runButton = () => document.querySelector('[data-name="schedule-dialog-toggle-run-button"]') as HTMLButtonElement

beforeEach(() => {
    setStore({schedules: [makeSchedule()]})
})

describe('列表行的工作目录可用性', () => {
    it('失效：行上出现「工作目录失效」标记，「立即执行」禁用且原因可读出', () => {
        setStore({
            schedules: [makeSchedule()],
            workspaceHealth: {s1: {state: 'missing', path: null, reason: '工作目录已不存在'}},
        })
        render(<ScheduleDialog/>)

        expect(chip()?.textContent).toBe('工作目录失效')
        expect(runButton().disabled).toBe(true)
        expect(runButton().getAttribute('aria-label')).toBe('立即执行不可用：工作目录已不存在')
        // 禁用不等于不可读：可访问名可被查询到（读屏软件能念出来）
        expect(screen.getByRole('button', {name: '立即执行不可用：工作目录已不存在'})).toBeTruthy()
    })

    it('改成有效工作目录（健康度重算为 ok）：标记消失、按钮恢复可点', () => {
        const {rerender} = render(<ScheduleDialog/>)
        expect(chip()).toBeNull()

        setStore({
            schedules: [makeSchedule()],
            workspaceHealth: {s1: {state: 'missing', path: null, reason: '工作目录已不存在'}},
        })
        rerender(<ScheduleDialog/>)
        expect(chip()).not.toBeNull()
        expect(runButton().disabled).toBe(true)

        setStore({
            schedules: [makeSchedule({workspaceId: 'ws-2'})],
            workspaceHealth: {s1: {state: 'ok', path: 'E:/ws2', reason: null}},
        })
        rerender(<ScheduleDialog/>)

        expect(chip()).toBeNull()
        expect(runButton().disabled).toBe(false)
        expect(screen.getByRole('button', {name: '立即执行'})).toBeTruthy()
        // 自动恢复：没有任何额外动作被要求（没有弹窗、没有重试入口挡在前面）
        expect(store.current.loadWorkspaceHealth).not.toHaveBeenCalled()
    })

    it('拿不到健康度（老桥接 / 取数失败）时按可用呈现：不显示标记、不禁用', () => {
        setStore({schedules: [makeSchedule()], workspaceHealth: {}})
        render(<ScheduleDialog/>)

        expect(chip()).toBeNull()
        expect(runButton().disabled).toBe(false)
    })
})
