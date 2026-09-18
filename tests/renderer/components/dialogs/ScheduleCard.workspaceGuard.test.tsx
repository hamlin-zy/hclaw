// @vitest-environment jsdom
/**
 * 定时任务行 · 项目失效标记与「立即执行」禁用（票 11 · workspace-guard）
 *
 * 口径：健康度由主进程判定（见 src/main/scheduler/scheduleWorkspace.ts），
 * 行卡片只**消费**它：
 *   - 不可用时行上出现标记（危险文字只用 `--text-danger`，见契约 C2）；
 *   - 「立即执行」禁用，且原因写进可访问名（读屏软件能读出来，不是只靠视觉）；
 *   - 换成可用项目后标记消失、按钮恢复可点（自动恢复，无需其他操作）。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import ScheduleCard from '../../../../src/renderer/components/dialogs/ScheduleCard'
import type {ScheduleUI} from '../../../../src/renderer/stores/scheduleStore'
import type {ScheduleWorkspaceHealth} from '@shared/types/scheduleWorkspace'

function makeSchedule(over: Partial<ScheduleUI> = {}): ScheduleUI {
    return {
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
        runCount: 3,
        createdAt: 1,
        updatedAt: 1,
        workspaceId: 'ws-1',
        ...over,
    } as ScheduleUI
}

function renderCard(
    health?: ScheduleWorkspaceHealth,
    over: Partial<ScheduleUI> = {},
    isRunning = false,
) {
    return render(
        <ScheduleCard
            schedule={makeSchedule(over)}
            isRunning={isRunning}
            searchQuery=""
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onToggleRun={vi.fn()}
            onTogglePause={vi.fn()}
            onToggleEnabled={vi.fn()}
            onToggleExpand={vi.fn()}
            isExpanded={false}
            workspaceHealth={health}
        />,
    )
}

const chip = () => document.querySelector('[data-name="schedule-dialog-workspace-chip"]')
const runButton = () => document.querySelector('[data-name="schedule-dialog-toggle-run-button"]') as HTMLButtonElement

describe('项目失效标记', () => {
    it.each([
        ['missing', '项目已不存在', '项目失效'],
        ['unset', '未设置项目', '未设置项目'],
        ['unavailable', '项目不可用（E:/gone）', '项目不可用'],
    ] as const)('%s：行上出现标记「%s」对应的文案', (state, reason, label) => {
        renderCard({state, path: state === 'unavailable' ? 'E:/gone' : null, reason})

        expect(chip()?.textContent).toBe(label)
        // C2：危险小字只取受对比度门禁的 --text-danger；底色/边框才用语义色
        expect(chip()?.className).toContain('text-[var(--text-danger)]')
        expect(chip()?.className).not.toMatch(/text-\[var\(--error\)\]/)
    })

    it('可用或拿不到判定时不显示标记（不制造假故障）', () => {
        const {unmount} = renderCard({state: 'ok', path: 'E:/ws1', reason: null})
        expect(chip()).toBeNull()
        unmount()

        renderCard(undefined)
        expect(chip()).toBeNull()
    })

    it('标记的底色/文字/边框/字号全部取自令牌（S4）：边框回到中性，字号 text-2xs', () => {
        renderCard({state: 'missing', path: null, reason: '项目已不存在'})

        const cls = chip()?.className ?? ''
        // 用户要的「标红」不减：--error-muted 作底 + --text-danger 作文字
        expect(cls).toContain('bg-[var(--error-muted)]')
        expect(cls).toContain('text-[var(--text-danger)]')
        // 契约只授权了「--error-muted 作底 + --text-danger 作文字」，没授权 --error 作边框
        expect(cls).toContain('border-[var(--border)]')
        expect(cls).not.toContain('border-[var(--error)]')
        // 字号令牌（tailwind.config.js 的 text-2xs = 10/14）
        expect(cls).toContain('text-2xs')
        expect(cls).not.toContain('text-[10px]')
    })
})

describe('「立即执行」按钮：不可用时禁用且原因可读出', () => {
    it('missing：按钮 disabled，title 与 aria-label 都真实承载原因', () => {
        renderCard({state: 'missing', path: null, reason: '项目已不存在'})

        const button = runButton()
        expect(button.disabled).toBe(true)
        // 可访问名里带原因（只靠视觉表达等于没说，H6）
        expect(button.getAttribute('aria-label')).toBe('立即执行不可用：项目已不存在')
        expect(button.getAttribute('title')).toBe('立即执行不可用：项目已不存在')
        expect(screen.getByRole('button', {name: '立即执行不可用：项目已不存在'})).toBeTruthy()
    })

    it('unavailable：原因里带上具体路径', () => {
        renderCard({state: 'unavailable', path: 'E:/gone', reason: '项目不可用（E:/gone）'})
        expect(runButton().getAttribute('aria-label')).toContain('E:/gone')
    })

    it('取不到 reason 时也给出非空的可访问名（不给读屏软件一个空名字）', () => {
        renderCard({state: 'unset', path: null, reason: null})
        expect(runButton().getAttribute('aria-label')).toBe('立即执行不可用：项目不可用')
    })

    it('可用时按钮照旧是「立即执行」且可点', () => {
        renderCard({state: 'ok', path: 'E:/ws1', reason: null})
        const button = runButton()
        expect(button.disabled).toBe(false)
        expect(screen.getByRole('button', {name: '立即执行'})).toBeTruthy()
    })
})

describe('改成有效项目后自动恢复', () => {
    it('同一条任务：不可用 → 可用，标记消失、按钮恢复可点', () => {
        const {rerender} = renderCard({state: 'missing', path: null, reason: '项目已不存在'})
        expect(chip()).not.toBeNull()
        expect(runButton().disabled).toBe(true)

        rerender(
            <ScheduleCard
                schedule={makeSchedule({workspaceId: 'ws-2'})}
                isRunning={false}
                searchQuery=""
                onEdit={vi.fn()}
                onDelete={vi.fn()}
                onToggleRun={vi.fn()}
                onTogglePause={vi.fn()}
                onToggleEnabled={vi.fn()}
                onToggleExpand={vi.fn()}
                isExpanded={false}
                workspaceHealth={{state: 'ok', path: 'E:/ws2', reason: null}}
            />,
        )

        expect(chip()).toBeNull()
        expect(runButton().disabled).toBe(false)
        expect(screen.getByRole('button', {name: '立即执行'})).toBeTruthy()
    })
})

/**
 * 复核 S3：失效只该拦「跑起来」，不该把「停下来」一起砍掉。
 * 场景：任务在目录尚可用时启动，运行中目录被删。
 */
describe('项目失效时「停止」仍然可点（S3）', () => {
    it('运行中 + 项目失效：按钮是可点的「停止」，不是禁用的「立即执行不可用：…」', () => {
        const {unmount} = renderCard({state: 'missing', path: null, reason: '项目已不存在'})
        // 先确认「未运行 + 失效」确实被拦（对照组就在同一个用例里，避免断言恒真）
        expect(runButton().disabled).toBe(true)
        unmount()

        renderCard({state: 'missing', path: null, reason: '项目已不存在'}, {}, true)

        const stop = screen.getByRole('button', {name: '停止'}) as HTMLButtonElement
        expect(stop.disabled).toBe(false)
        expect(stop.getAttribute('data-name')).toBe('schedule-dialog-toggle-run-button')
        expect(screen.queryByRole('button', {name: /立即执行不可用/})).toBeNull()
    })

    it('运行中 + 目录不可用（unavailable）：同样给「停止」', () => {
        renderCard({state: 'unavailable', path: 'E:/gone', reason: '项目不可用（E:/gone）'}, {}, true)

        const stop = screen.getByRole('button', {name: '停止'}) as HTMLButtonElement
        expect(stop.disabled).toBe(false)
        expect(screen.queryByRole('button', {name: /立即执行不可用/})).toBeNull()
    })
})
