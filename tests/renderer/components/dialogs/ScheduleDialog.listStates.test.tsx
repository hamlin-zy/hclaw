// @vitest-environment jsdom
/**
 * ScheduleDialog 列表区三态与空态引导（ui-03）
 *
 * 口径（spec「Testing Decisions」seam 1）：渲染组件、mock store，断言**用户能看到什么、
 * 点了会发生什么**；不断言组件内部 state、不断言 DOM 层级。异步断言等条件，不固定延时。
 *
 * 覆盖：
 * - 加载中有明确呈现，不是一片空白
 * - 加载失败给出原因 + 重试入口，不被当成「我没有任务」
 * - 真一条都没有 → 用途说明 + 显眼的「新建定时任务」（点击即打开新建弹窗）
 * - 筛选后无结果 → 针对筛选的文案（按状态 / 按搜索词），与「一条都没有」不同
 * - 空态动作可键盘触达（原生 button）
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import ScheduleDialog from '../../../../src/renderer/components/dialogs/ScheduleDialog'

// ── store mock：组件经 useScheduleStore() 无 selector 取值，故按对象整取 ──
const store = vi.hoisted(() => ({current: {} as any}))
vi.mock('../../../../src/renderer/stores/scheduleStore', () => ({
    useScheduleStore: () => store.current,
}))

// ── 编辑弹窗替换为轻量桩：本票只关心「动作能否触发」，不重复测表单 ──
vi.mock('../../../../src/renderer/components/dialogs/ScheduleEditModal', () => ({
    ScheduleEditModal: ({initial}: {initial?: {id?: string}}) => (
        <div data-name="stub-schedule-edit-modal">{initial ? `编辑弹窗 ${initial.id}` : '新建弹窗'}</div>
    ),
}))

/** 列表行（ScheduleUI 的最小可用形状） */
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

/** 归一化 store 状态（只给用例关心的字段，其余给稳定桩） */
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
        ...partial,
    }
    return store.current
}

beforeEach(() => {
    setStore()
})

describe('列表区三态', () => {
    it('加载中：给出明确的加载呈现，不出现任何空态文案', () => {
        setStore({loading: true})
        render(<ScheduleDialog/>)

        expect(screen.getByText('加载中...')).toBeTruthy()
        expect(screen.queryByText('还没有定时任务')).toBeNull()
        expect(screen.queryByText('新建定时任务')).toBeNull()
        expect(screen.queryByText(/没有匹配/)).toBeNull()
    })

    it('加载失败：显示失败原因与重试入口，而不是被当成「我没有任务」', () => {
        const state = setStore({error: '定时任务存储异常（query）：db closed'})
        render(<ScheduleDialog/>)

        expect(screen.getByText('定时任务加载失败')).toBeTruthy()
        expect(screen.getByText('定时任务存储异常（query）：db closed')).toBeTruthy()
        expect(screen.queryByText('还没有定时任务')).toBeNull()

        // 挂载时的首次加载已计入，这里只看「点重试会不会再取一次」
        state.loadSchedules.mockClear()
        fireEvent.click(screen.getByRole('button', {name: '重试'}))
        expect(state.loadSchedules).toHaveBeenCalledTimes(1)
    })

    it('重试是显式无参调用：不会把点击事件当成参数传给 loadSchedules，并回到加载态', () => {
        const state = setStore({error: '定时任务存储异常（query）：db closed'})
        // 真实 store 的 loadSchedules 会把自己置为 loading；mock 照做，
        // 再 rerender 模拟「store 变了 → 组件重渲染」
        state.loadSchedules.mockImplementation(async () => {
            store.current = {...store.current, loading: true, error: null}
        })
        const {rerender} = render(<ScheduleDialog/>)

        state.loadSchedules.mockClear()
        fireEvent.click(screen.getByRole('button', {name: '重试'}))

        expect(state.loadSchedules).toHaveBeenCalledTimes(1)
        // 无参：既不是 React 合成事件对象，也没被当成 {silent:true} 的静默刷新
        expect(state.loadSchedules.mock.calls[0][0]).toBeUndefined()

        rerender(<ScheduleDialog/>)
        expect(screen.getByText('加载中...')).toBeTruthy()
        expect(screen.queryByText('定时任务加载失败')).toBeNull()
    })

    it('桥接缺失与后端失败的原因都可读、且各不相同', () => {
        setStore({error: 'scheduler API 不可用'})
        const {unmount} = render(<ScheduleDialog/>)
        expect(screen.getByText('scheduler API 不可用')).toBeTruthy()
        unmount()

        setStore({error: '定时任务存储异常（query）：db closed'})
        render(<ScheduleDialog/>)
        expect(screen.getByText('定时任务存储异常（query）：db closed')).toBeTruthy()
    })
})

describe('空态引导', () => {
    it('真的一条都没有：给出本窗口用途说明与显眼的「新建定时任务」，点击即打开新建弹窗', () => {
        setStore({schedules: []})
        render(<ScheduleDialog/>)

        expect(screen.getByText('还没有定时任务')).toBeTruthy()
        expect(screen.getByText(/自动执行 Agent、Skill、Command 或脚本/)).toBeTruthy()

        const action = screen.getByRole('button', {name: '新建定时任务'})
        expect(screen.queryByText('新建弹窗')).toBeNull()
        fireEvent.click(action)
        expect(screen.getByText('新建弹窗')).toBeTruthy()
    })

    it('空态动作可键盘触达：原生 button、未禁用、不在 Tab 序之外', () => {
        setStore({schedules: []})
        render(<ScheduleDialog/>)

        const action = screen.getByRole('button', {name: '新建定时任务'})
        expect(action.tagName).toBe('BUTTON')
        expect((action as HTMLButtonElement).disabled).toBe(false)
        expect(action.getAttribute('tabindex')).not.toBe('-1')
    })

    it('筛选后无结果：文案针对当前筛选维度，并给出清除筛选的出路', () => {
        setStore({schedules: [makeSchedule({id: 's1', name: '每日构建'})]})
        render(<ScheduleDialog/>)

        fireEvent.click(screen.getByRole('button', {name: /^禁用/}))

        expect(screen.getByText('没有「禁用」的定时任务')).toBeTruthy()
        expect(screen.queryByText('还没有定时任务')).toBeNull()

        const clear = screen.getByRole('button', {name: '查看全部任务'})
        expect(clear.tagName).toBe('BUTTON')
        fireEvent.click(clear)
        expect(screen.getByText('每日构建')).toBeTruthy()
    })

    it('搜索无结果：文案指向搜索词，与「一条都没有」不同', async () => {
        setStore({schedules: [makeSchedule({id: 's1', name: '每日构建'})]})
        render(<ScheduleDialog/>)

        fireEvent.change(screen.getByPlaceholderText('搜索定时任务...'), {target: {value: 'zzz'}})

        await waitFor(() => expect(screen.getByText('没有匹配“zzz”的定时任务')).toBeTruthy())
        expect(screen.queryByText('还没有定时任务')).toBeNull()
    })
})
