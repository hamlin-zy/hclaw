// @vitest-environment jsdom
/**
 * ScheduleCard 行本体：可访问名与暂停入口（ui-06 复核问题单）
 *
 * 1. **可访问名必须来自行内可见内容**（设计契约 H2）：行本体曾写
 *    `aria-label={`${name} 执行记录`}`，`aria-label` 会**覆盖**由内容推导的可访问名，
 *    读屏聚焦该行时听不到配置态 / 上次执行结果 + 相对时间 / 人话频率摘要。删除后
 *    可访问名由内容合成，本测试断言它**同时包含**这四类关键片段。
 * 2. **暂停/恢复入口只在「启用」时给出**：`enabled=false && paused=true` 时行内已呈现
 *    「已禁用」，再给「恢复」会与禁用语义同框且点击没有任何可见变化。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import ScheduleCard from '../../../../src/renderer/components/dialogs/ScheduleCard'
import type {ScheduleUI} from '../../../../src/renderer/stores/scheduleStore'

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
        workspaceId: null,
        ...over,
    } as ScheduleUI
}

function renderCard(schedule: ScheduleUI) {
    return render(
        <ScheduleCard
            schedule={schedule}
            isRunning={false}
            searchQuery=""
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onToggleRun={vi.fn()}
            onTogglePause={vi.fn()}
            onToggleEnabled={vi.fn()}
            onToggleExpand={vi.fn()}
            isExpanded={false}
        />,
    )
}

describe('行本体的可访问名来自行内可见内容（H2）', () => {
    it('可访问名同时含任务名、配置态、上次结果 + 相对时间、人话频率摘要', () => {
        renderCard(makeSchedule({lastRunAt: Date.now(), lastRunStatus: 'success'}))

        const row = screen.getByRole('button', {
            name: /^每日构建[\s\S]*启用[\s\S]*上次: 成功[\s\S]*刚刚[\s\S]*每天 09:00/,
        })
        // 行本体不声明展开状态（ui-09 复核整改 A6）：行上「点=展开 / Enter=编辑」
        // 与 disclosure 语义自相矛盾，`aria-expanded` 归行内「执行记录」按钮。
        expect(row.getAttribute('aria-expanded')).toBeNull()
        expect(
            document.querySelector('[data-name="schedule-dialog-history-button"]')!.getAttribute('aria-expanded'),
        ).toBe('false')
    })

    it('可访问名不再被 `aria-label` 覆盖成「任务名 执行记录」', () => {
        renderCard(makeSchedule({enabled: false, paused: false, lastRunStatus: 'failure'}))

        expect(screen.queryByRole('button', {name: '每日构建 执行记录'})).toBeNull()
        const row = screen.getByRole('button', {
            name: /^每日构建[\s\S]*已禁用[\s\S]*上次: 失败/,
        })
        expect(row.getAttribute('data-name')).toBe('schedule-dialog-row')
    })

    it('无法归类的表达式在行内回显 cron 原文（前缀「自定义」）', () => {
        renderCard(makeSchedule({cronExpression: '0 9 1,15 * *'}))

        const row = screen.getByRole('button', {name: /^每日构建[\s\S]*自定义 0 9 1,15 \* \*/})
        expect(row.textContent).toContain('自定义 0 9 1,15 * *')
    })
})

describe('暂停 / 恢复入口只在「启用」时给出', () => {
    it('enabled=false && paused=true：不渲染暂停/恢复按钮', () => {
        renderCard(makeSchedule({enabled: false, paused: true}))

        expect(screen.queryByRole('button', {name: '恢复'})).toBeNull()
        expect(screen.queryByRole('button', {name: '暂停'})).toBeNull()
        expect(document.querySelector('[data-name="schedule-dialog-pause-button"]')).toBeNull()
    })

    it('enabled=true && paused=true：渲染「恢复」', () => {
        renderCard(makeSchedule({enabled: true, paused: true}))

        expect(screen.getByRole('button', {name: '恢复'})).toBeTruthy()
        expect(screen.queryByRole('button', {name: '暂停'})).toBeNull()
    })

    it('enabled=true && paused=false：渲染「暂停」', () => {
        renderCard(makeSchedule({enabled: true, paused: false}))

        expect(screen.getByRole('button', {name: '暂停'})).toBeTruthy()
        expect(screen.queryByRole('button', {name: '恢复'})).toBeNull()
    })

    it('enabled=false && paused=false：同样不渲染暂停/恢复按钮', () => {
        renderCard(makeSchedule({enabled: false, paused: false}))

        expect(screen.queryByRole('button', {name: '恢复'})).toBeNull()
        expect(screen.queryByRole('button', {name: '暂停'})).toBeNull()
    })
})
