// @vitest-environment jsdom
/**
 * ScheduleDialog 筛选即统计（ui-04）
 *
 * 口径（spec「Testing Decisions」seam 1）：渲染组件、mock store，断言**用户能看到什么、
 * 点了会发生什么**。计数断言经筛选行自带的 data-name 取到那个数字元素（命名体例与
 * 列表其它交互元素一致），不依赖 DOM 层级。
 *
 * 覆盖：
 * - 筛选与统计合并为一处（筛选行即统计行），不再有两套命名
 * - 计数与筛选同源：每个维度显示的数 = 点进去看到的结果条数
 * - 「失败」已不是筛选维度（2026-09-16 移除 tab），失败仍按行表达（上次：失败）
 * - 零值不着色：值为 0 的计数落中性文字色，不出现任何状态色
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
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

/** 三条记录：启用+成功 / 启用+失败 / 禁用+成功（s3 为系统任务，归入「系统任务」维度） */
const FIXTURE = [
    makeSchedule({id: 's1', name: '每日构建', enabled: true, lastRunStatus: 'success'}),
    makeSchedule({id: 's2', name: '备份失败重试', enabled: true, lastRunStatus: 'failure'}),
    makeSchedule({id: 's3', name: '周末巡检', enabled: false, lastRunStatus: 'success', isSystem: true}),
]

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
        runNow: vi.fn(async () => ({ok: true, data: true})),
        restoreDefault: vi.fn(async () => ({ok: true, data: null})),
        ...partial,
    }
    return store.current
}

/** 取筛选行里某个维度的计数文本 */
function countText(key: string): string {
    const el = document.querySelector(`[data-name="schedule-dialog-tab-count-${key}"]`)
    if (!el) throw new Error(`未找到 ${key} 的计数元素`)
    return el.textContent ?? ''
}

/** 取筛选行里某个维度的计数元素的 className（用于「零值不着色」判定） */
function countClasses(key: string): string {
    const el = document.querySelector(`[data-name="schedule-dialog-tab-count-${key}"]`)
    if (!el) throw new Error(`未找到 ${key} 的计数元素`)
    return el.className
}

describe('筛选即统计', () => {
    it('筛选行同时承载计数：同一维度只有一套枚举名，不再有底部统计栏的第二套说法', () => {
        setStore({schedules: FIXTURE})
        render(<ScheduleDialog/>)

        // 筛选行的四个维度都在，且各带一个计数（「失败」tab 已于 2026-09-16 移除）。
        // 用 `^` 锚定：行本体也是 role=button，且其可访问名来自行内可见内容（无 aria-label，见 H2），
        // 因而含「已禁用」等字样；不加锚点会让 /禁用/ 同时命中筛选 tab 与那些行。
        expect(screen.getByRole('button', {name: /^用户/})).toBeTruthy()
        expect(screen.getByRole('button', {name: /^系统任务/})).toBeTruthy()
        expect(screen.getByRole('button', {name: /^启用/})).toBeTruthy()
        expect(screen.getByRole('button', {name: /^禁用/})).toBeTruthy()
        expect(screen.queryByRole('button', {name: /^失败/})).toBeNull()
        expect(screen.queryByRole('button', {name: /^全部/})).toBeNull()

        // 旧的底部统计栏独有的两个说法不再出现
        expect(screen.queryByText(/总数/)).toBeNull()
        expect(screen.queryByText(/运行中/)).toBeNull()
    })

    it('计数与筛选同源：每个维度显示的数 = 点进去看到的那一批', () => {
        setStore({schedules: FIXTURE})
        render(<ScheduleDialog/>)

        expect(countText('user')).toBe('2')
        expect(countText('system')).toBe('1')
        expect(countText('enabled')).toBe('2')
        expect(countText('disabled')).toBe('1')

        // 用户（默认 tab）→ 用户任务都在
        expect(screen.getByText('每日构建')).toBeTruthy()
        expect(screen.getByText('备份失败重试')).toBeTruthy()
        expect(screen.queryByText('周末巡检')).toBeNull()

        // 禁用（计数 1）→ 只剩禁用的那条
        fireEvent.click(screen.getByRole('button', {name: /^禁用/}))
        expect(screen.getByText('周末巡检')).toBeTruthy()
        expect(screen.queryByText('每日构建')).toBeNull()
        expect(screen.queryByText('备份失败重试')).toBeNull()
    })

    it('「失败」不再是筛选维度，失败仍按行表达（上次：失败）', () => {
        setStore({schedules: FIXTURE})
        render(<ScheduleDialog/>)

        // 筛选行没有「失败」档
        expect(screen.queryByRole('button', {name: /^失败/})).toBeNull()

        // 失败任务照旧在列表里，并按行给出「上次：失败」（记录里的取值是 failure）；
        // 「失败」只出现在该行一处，不再是「未执行」
        expect(screen.getByText('备份失败重试')).toBeTruthy()
        expect(screen.getAllByText('失败')).toHaveLength(1)
        expect(screen.queryByText('未执行')).toBeNull()
    })

    it('计数随筛选（搜索）变化，筛选结果与计数始终一致', () => {
        setStore({schedules: FIXTURE})
        render(<ScheduleDialog/>)

        fireEvent.change(screen.getByPlaceholderText('搜索定时任务...'), {target: {value: '备份'}})

        expect(countText('user')).toBe('1')
        expect(countText('system')).toBe('0')
        expect(countText('enabled')).toBe('1')
        expect(countText('disabled')).toBe('0')
        // 命中项仍在列表里（搜索词被高亮成独立节点，故断言命中词之后的那段文本）
        expect(screen.getByText('失败重试')).toBeTruthy()
        expect(screen.queryByText('每日构建')).toBeNull()
        expect(screen.queryByText('周末巡检')).toBeNull()
    })
})

describe('零值不着色', () => {
    it('计数一律落中性文字色：不出现 danger/error/success/info 任何状态色', () => {
        setStore({schedules: FIXTURE})
        render(<ScheduleDialog/>)

        for (const key of ['user', 'system', 'enabled', 'disabled']) {
            const classes = countClasses(key)
            expect(classes, `${key} 计数应中性`).toContain('text-[var(--text-muted)]')
            expect(classes, `${key} 计数不应带状态色`).not.toMatch(/danger|error|success|info/)
        }
    })

    it('计数为零的筛选态：空结果文案沿用筛选行的同一套命名', () => {
        setStore({schedules: FIXTURE.filter(s => s.enabled)})
        render(<ScheduleDialog/>)

        expect(countText('disabled')).toBe('0')
        fireEvent.click(screen.getByRole('button', {name: /^禁用/}))
        expect(screen.getByText('没有「禁用」的定时任务')).toBeTruthy()
    })

    it('零值维度（禁用）同样中性', () => {
        setStore({schedules: [makeSchedule({id: 's1', name: '每日构建', enabled: true})]})
        render(<ScheduleDialog/>)

        expect(countText('disabled')).toBe('0')
        expect(countClasses('disabled')).not.toMatch(/danger|error|success|info/)
    })
})
