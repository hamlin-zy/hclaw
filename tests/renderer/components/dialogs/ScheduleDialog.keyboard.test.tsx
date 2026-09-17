// @vitest-environment jsdom
/**
 * 定时任务列表 · 键盘全程可用（ui-09，H6）
 *
 * 判据：「行可聚焦，↑↓ 移动、Enter 编辑」。
 *  - ↑↓ 在同一筛选结果的行之间移动焦点（首/尾不越界），并阻止页面滚动；
 *  - Enter 打开该行的编辑窗口（行本体原本靠 Enter 触发展开——展开改由行内
 *    「执行记录」按钮承担，且该按钮是**唯一**声明 `aria-expanded` 的地方，
 *    行本体不带它，见 ui-09 复核整改 A6；键盘能力只增不减）；
 *  - 搜索框有可被读出的名字（不是只靠 placeholder）。
 *
 * 编辑弹窗在此 mock 成回显 props 的桩：本文件只断言「焦点停在哪一行、Enter 打开了谁」。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import ScheduleDialog from '../../../../src/renderer/components/dialogs/ScheduleDialog'
import ScheduleCard from '../../../../src/renderer/components/dialogs/ScheduleCard'
import type {ScheduleUI} from '../../../../src/renderer/stores/scheduleStore'

const h = vi.hoisted(() => ({
    store: {} as any,
    modalProps: null as any,
}))

vi.mock('../../../../src/renderer/stores/scheduleStore', () => ({
    useScheduleStore: () => h.store,
}))

vi.mock('../../../../src/renderer/components/dialogs/ScheduleEditModal', () => ({
    ScheduleEditModal: (props: any) => {
        h.modalProps = props
        return <div data-name="stub-schedule-edit-modal"/>
    },
}))

// 行内展开面板会走 scheduler 通道；本文件不关心它
vi.mock('../../../../src/renderer/components/dialogs/ScheduleConversationsPanel', () => ({
    default: () => <div data-name="stub-schedule-conversations-panel"/>,
}))

const makeSchedule = (id: string, name: string) => ({
    id,
    name,
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
})

beforeEach(() => {
    h.modalProps = null
    h.store = {
        schedules: [makeSchedule('s1', '任务甲'), makeSchedule('s2', '任务乙'), makeSchedule('s3', '任务丙')],
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
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function rows(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('[data-name="schedule-dialog-row"]')) as HTMLButtonElement[]
}

describe('列表 ↑↓ 移动焦点（H6）', () => {
    it('ArrowDown 依次下移，到底不越界；ArrowUp 依次上移，到顶不越界', () => {
        render(<ScheduleDialog/>)
        const r = rows()
        expect(r.length).toBe(3)

        r[0].focus()
        expect(document.activeElement).toBe(r[0])

        fireEvent.keyDown(r[0], {key: 'ArrowDown'})
        expect(document.activeElement).toBe(r[1])

        fireEvent.keyDown(r[1], {key: 'ArrowDown'})
        expect(document.activeElement).toBe(r[2])

        // 尾部边界：停在原地，不跳回第一行、也不丢焦点
        fireEvent.keyDown(r[2], {key: 'ArrowDown'})
        expect(document.activeElement).toBe(r[2])

        fireEvent.keyDown(r[2], {key: 'ArrowUp'})
        expect(document.activeElement).toBe(r[1])

        fireEvent.keyDown(r[1], {key: 'ArrowUp'})
        expect(document.activeElement).toBe(r[0])

        // 顶部边界
        fireEvent.keyDown(r[0], {key: 'ArrowUp'})
        expect(document.activeElement).toBe(r[0])
    })

    it('↑↓ 被消费掉（阻止默认），不会连带滚动列表', () => {
        render(<ScheduleDialog/>)
        const r = rows()
        const down = new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})
        r[0].dispatchEvent(down)
        expect(down.defaultPrevented).toBe(true)
    })
})

describe('Enter 即编辑（H6）', () => {
    it('在第二行按 Enter 打开编辑窗口，且带的是第二行的数据', () => {
        render(<ScheduleDialog/>)
        const r = rows()

        fireEvent.keyDown(r[1], {key: 'Enter'})

        expect(document.querySelector('[data-name="stub-schedule-edit-modal"]')).toBeTruthy()
        expect(h.modalProps.initial.id).toBe('s2')
        expect(h.modalProps.initial.name).toBe('任务乙')
    })

    it('Enter 打开编辑而非展开：preventDefault 拦下默认行为，onEdit 被调用、onToggleExpand 未被调用', () => {
        // ⚠️ jsdom 的能力缺口（本条测试存在的理由）：
        //   jsdom **不实现**「Enter/Space 激活 button」这条浏览器默认行为——`fireEvent.keyDown(Enter)`
        //   根本不会派发 click。因此旧版那条「按 Enter 后 `aria-expanded` 仍为 false」在本环境里
        //   恒真、零证据力：把 `e.preventDefault()` 删掉它照样通过。
        //   真实浏览器里拦住 Enter→click 的**正是** `preventDefault()`，故这里直接断言
        //   `defaultPrevented`；并把「调用 onEdit、不调用 onToggleExpand」用 spy 钉死。
        //   本用例渲染 ScheduleCard 本体（而非 ScheduleDialog）就是为了拿到这两个回调的 spy。
        const onEdit = vi.fn()
        const onToggleExpand = vi.fn()
        render(
            <ScheduleCard
                schedule={makeSchedule('s1', '任务甲') as unknown as ScheduleUI}
                isRunning={false}
                searchQuery=""
                onEdit={onEdit}
                onDelete={vi.fn()}
                onToggleRun={vi.fn()}
                onTogglePause={vi.fn()}
                onToggleEnabled={vi.fn()}
                onToggleExpand={onToggleExpand}
                isExpanded={false}
            />,
        )
        const row = document.querySelector('[data-name="schedule-dialog-row"]') as HTMLButtonElement
        expect(row).toBeTruthy()

        const ev = new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})
        row.dispatchEvent(ev)

        expect(ev.defaultPrevented, 'Enter 必须被 preventDefault，否则真实浏览器会连带触发行的 click→展开').toBe(true)
        expect(onEdit).toHaveBeenCalledTimes(1)
        expect(onToggleExpand).not.toHaveBeenCalled()
    })

    it('行内「执行记录」按钮仍是键盘可达的展开入口（且是唯一声明 aria-expanded 的地方）', () => {
        render(<ScheduleDialog/>)

        // 行本体不声明展开状态（A6：与「Enter=编辑」自相矛盾）
        expect(rows()[0].getAttribute('aria-expanded')).toBeNull()

        const history = screen.getAllByRole('button', {name: '展开执行记录'})[0]
        expect(history.getAttribute('aria-expanded')).toBe('false')
        fireEvent.click(history)
        expect(document.querySelector('[data-name="stub-schedule-conversations-panel"]')).toBeTruthy()
    })
})

describe('搜索框有可被读出的名字（H6）', () => {
    it('按可访问名「搜索定时任务」能找到搜索框', () => {
        render(<ScheduleDialog/>)

        const input = screen.getByLabelText('搜索定时任务')
        expect(input.getAttribute('data-name')).toBe('schedule-dialog-input')
    })
})

describe('列表内的纯图标按钮一律有 aria-label（H6）', () => {
    it('卡片上的暂停 / 立即执行 / 执行记录 / 编辑 / 删除 五个图标按钮都有名字', () => {
        render(<ScheduleDialog/>)

        const iconOnly = Array.from(document.querySelectorAll('button')).filter(
            b => (b.textContent ?? '').trim() === '',
        ) as HTMLButtonElement[]
        expect(iconOnly.length).toBeGreaterThanOrEqual(5)

        const unnamed = iconOnly
            .filter(b => !b.getAttribute('aria-label')?.trim())
            .map(b => b.getAttribute('data-name') ?? b.outerHTML.slice(0, 60))
        expect(unnamed).toEqual([])
    })
})
