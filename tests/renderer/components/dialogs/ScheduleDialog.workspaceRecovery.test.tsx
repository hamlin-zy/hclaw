// @vitest-environment jsdom
/**
 * 定时任务窗口 · 「改成有效项目后自动恢复」的端到端接线（票 11 复核 S7）
 *
 * 为什么要有这一条：既有用例里，卡片层用 `vi.mock` 桩掉整个 store + 手动 `rerender`，
 * store 层只测到「健康度被重新拉取」——**没有一条**证明「主进程广播 → 渲染层 → 行标记
 * 消失 + 按钮恢复可点」这条链是**自动**跑的（那两条都是「测试自己把界面重画了一遍」）。
 *
 * 本文件用**真实 store** + 桩掉的 IPC 桥（preload 那层），只模拟「主进程广播」这一个外部
 * 事件，然后断言界面自己变了：不需要用户点任何东西、不需要测试手动 rerender。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, waitFor, cleanup} from '@testing-library/react'

const h = vi.hoisted(() => {
    const changedHandlers: Array<(change?: unknown) => void> = []
    const scheduler: Record<string, unknown> = {
        onChanged: vi.fn((fn: (change?: unknown) => void) => { changedHandlers.push(fn) }),
        list: vi.fn(),
        workspaceHealth: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        stop: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        runNow: vi.fn(),
    }
    // 在**真实的 jsdom window** 上补桥：整只替换 window 会让 framer-motion 一类库
    // （要 window.addEventListener）在渲染时炸掉，那与本用例要证明的接线无关。
    const g = globalThis as unknown as {window?: Record<string, unknown>}
    const realWindow = g.window ?? {}
    realWindow.electronAPI = {
        scheduler,
        getPlatform: () => Promise.resolve('win32'),
        workspace: {list: () => Promise.resolve([]), getCurrent: () => Promise.resolve(null)},
        capability: {query: () => Promise.resolve([]), onCapabilityChanged: () => () => {}},
    }
    g.window = realWindow
    return {scheduler, changedHandlers}
})

import ScheduleDialog from '../../../../src/renderer/components/dialogs/ScheduleDialog'
import {useScheduleStore} from '../../../../src/renderer/stores/scheduleStore'

const rawSchedule = {
    id: 's1',
    name: '每日构建',
    description: '',
    cronExpression: '0 9 * * *',
    taskType: 'agent',
    taskTarget: 'code-reviewer',
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

const MISSING = {state: 'missing' as const, path: null, reason: '项目已不存在'}
const OK = {state: 'ok' as const, path: 'E:/ws2', reason: null}

const chip = () => document.querySelector('[data-name="schedule-dialog-workspace-chip"]')
const runButton = () => document.querySelector('[data-name="schedule-dialog-toggle-run-button"]') as HTMLButtonElement

beforeEach(() => {
    vi.clearAllMocks()
    h.scheduler.list = vi.fn().mockResolvedValue({ok: true, data: [rawSchedule]})
    h.scheduler.workspaceHealth = vi.fn().mockResolvedValue({ok: true, data: {s1: MISSING}})
    useScheduleStore.setState({schedules: [], loading: false, error: null, workspaceHealth: {}})
})

afterEach(() => {
    cleanup()
})

/** 渲染窗口并等它把列表与健康度都取回来（真实 store 的那次挂载取数） */
async function renderLoaded() {
    render(<ScheduleDialog/>)
    await waitFor(() => expect(chip()).not.toBeNull())
    return h.scheduler.list as ReturnType<typeof vi.fn>
}

describe('自动恢复：主进程广播 → 渲染层 → 行标记消失 + 按钮恢复可点（S7）', () => {
    it('用户把项目改成有效值，主进程广播 updated 后界面自己恢复（无需任何额外操作）', async () => {
        const listSpy = await renderLoaded()

        expect(chip()?.textContent).toBe('项目失效')
        expect(runButton().disabled).toBe(true)
        expect(screen.getByRole('button', {name: '立即执行不可用：项目已不存在'})).toBeTruthy()
        const listCallsBefore = listSpy.mock.calls.length

        // 主进程侧：改了项目 → 记录更新 → 健康度重算为 ok → 广播 updated
        h.scheduler.workspaceHealth = vi.fn().mockResolvedValue({ok: true, data: {s1: OK}})
        h.changedHandlers[0]({type: 'updated', record: {...rawSchedule, workspaceId: 'ws-2'}})

        // 界面自己恢复：没有测试手动 rerender、没有用户点击
        await waitFor(() => expect(chip()).toBeNull())
        await waitFor(() => expect(runButton().disabled).toBe(false))
        expect(screen.getByRole('button', {name: '立即执行'})).toBeTruthy()
        // 行数据就地更新（没有整表重取 —— 不闪、不重置滚动位置）
        expect(useScheduleStore.getState().schedules[0].workspaceId).toBe('ws-2')
        expect(listSpy.mock.calls.length).toBe(listCallsBefore)
    })

    it('目录被外部修好但**没有任何广播**时，界面不会自己变（防止本用例退化成恒真）', async () => {
        await renderLoaded()
        expect(chip()).not.toBeNull()

        // 只改桥的返回值、不发广播 —— 界面不该有任何变化（这就是「刷新由广播驱动」的反证）
        h.scheduler.workspaceHealth = vi.fn().mockResolvedValue({ok: true, data: {s1: OK}})
        await new Promise(resolve => setTimeout(resolve, 250))

        expect(chip()).not.toBeNull()
        expect(runButton().disabled).toBe(true)
    })
})
