// @vitest-environment jsdom
/**
 * 定时任务 · 执行记录（能力类：会话列表 + 跳转；脚本类：日志）
 *
 * 【2026-09-16 修订 · feat/schedule-jump-to-conversation】
 * 执行记录不再内联渲染会话消息正文（那份副本没有工具块 / Markdown / 附件，劣于会话页），
 * 改为**点击整行跳转到该会话**。凡断言「内联渲染消息正文 / 展开全文截断」的用例已改写为
 * 「调用 setActiveConversation 且传入正确 convId，且不再调用已删除的 conversationDetail 通道」。
 *
 * 【2026-09-16 修订 · 跨窗口投递】本面板跑在独立配置窗口，其会话 store 从未加载
 * （currentWorkspacePath 恒为 null），就地激活只改到本进程 → 跳转从未生效。现改为投递给
 * 主进程（`app.openConversation({conversationId, workspacePath})`），由主窗口切工作区并激活；
 * 故跳转断言改为「投递参数正确」+「成功不打扰 / 失败给出可读原因」。
 *
 * 口径（spec「Testing Decisions」seam 1）：渲染组件、mock store 与 electronAPI，
 * 断言**用户能看到什么、点了会发生什么**。
 *
 * 覆盖：
 * - 详情在**该行下方就地展开**，`aria-expanded` 落在行内「执行记录」按钮上
 *   （ui-09 复核整改 A6：行本体上「点=展开 / Enter=编辑」与 disclosure 语义分叉，
 *   展开状态的声明已从行本体移到该按钮），鼠标点行即可展开
 * - 同一时刻只允许展开一行
 * - 能力类任务：列出调度会话（标题 + preview），点整行跳转到会话页
 * - 能力类三态齐备且互相区分：加载中 / 加载失败（可读原因 + 重试）/ 还没有执行记录
 * - 脚本类三态齐备，且「加载失败」不再被吞成空数组
 * - 日志过大时明确告知并标注被截断
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'
import ScheduleDialog from '../../../../src/renderer/components/dialogs/ScheduleDialog'

const store = vi.hoisted(() => ({current: {} as any}))
vi.mock('../../../../src/renderer/stores/scheduleStore', () => ({
    useScheduleStore: () => store.current,
}))
vi.mock('../../../../src/renderer/components/dialogs/ScheduleEditModal', () => ({
    ScheduleEditModal: () => <div data-name="stub-schedule-edit-modal"/>,
}))

// 会话 store：面板**已不再**就地激活（跳转改为跨窗口投递，见下），此替身仅防相邻组件
// 引入真实 store 的重依赖。
const convStore = vi.hoisted(() => ({
    currentWorkspacePath: 'E:/ws' as string | null,
    setActiveConversation: vi.fn(async () => {}),
}))
vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {getState: () => convStore},
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

// conversationDetail 已从 preload/env 删除；此处保留替身，用于断言「跳转后不再调用它」。
const api = vi.hoisted(() => ({
    getConversations: vi.fn(),
    conversationDetail: vi.fn(),
    scriptLogs: vi.fn(),
    readScriptLog: vi.fn(),
    // 跨窗口跳转：面板投递给主进程，由主窗口切工作区 + 激活会话
    openConversation: vi.fn(),
}))

beforeEach(() => {
    setStore()
    api.getConversations.mockReset()
    api.conversationDetail.mockReset()
    api.scriptLogs.mockReset()
    api.readScriptLog.mockReset()
    api.openConversation.mockReset()
    // 默认成功：不打扰（具体用例自行覆盖回执）
    api.openConversation.mockResolvedValue({ok: true})
    convStore.currentWorkspacePath = 'E:/ws'
    convStore.setActiveConversation.mockReset()
    vi.stubGlobal('electronAPI', {scheduler: api, app: {openConversation: api.openConversation}})
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const conv = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    title: '每日构建 · 09:00',
    workspacePath: 'E:/ws',
    createdAt: 1,
    updatedAt: Date.now(),
    preview: '抓到 3 条昨日进展',
    status: 'active',
    ...over,
})

/**
 * 行本体。行本体**不再有 `aria-label`**（H2：那会覆盖由内容推导的可访问名，
 * 读屏就听不到配置态 / 上次结果 / 频率摘要），故只能按「以任务名开头」定位。
 */
const rowOf = (name: string) => screen.getByRole('button', {name: new RegExp(`^${name}`)})

/**
 * 该行的「执行记录」按钮——**展开状态的唯一声明处**（A6）。
 * 行本体不再带 `aria-expanded`；按钮是行本体的兄弟节点，故从行往上找最近的容器再查。
 */
const historyBtnOf = (name: string): HTMLElement => {
    const btn = rowOf(name).closest('div')?.querySelector('[data-name="schedule-dialog-history-button"]')
    expect(btn, `找不到「${name}」行的执行记录按钮`).toBeTruthy()
    return btn as HTMLElement
}

/** 展开第一行 */
function expandFirstRow() {
    fireEvent.click(rowOf('每日构建'))
}

describe('行内展开的形态（B1）', () => {
    it('展开状态声明在行内「执行记录」按钮上（A6：行本体不再是 disclosure），点行即就地展开、再点收起', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: []})
        setStore({schedules: [makeSchedule()]})
        render(<ScheduleDialog/>)

        const row = rowOf('每日构建')
        // 行本体不声明展开状态（否则与「Enter=编辑」自相矛盾）
        expect(row.getAttribute('aria-expanded')).toBeNull()
        expect(historyBtnOf('每日构建').getAttribute('aria-expanded')).toBe('false')

        await act(async () => { fireEvent.click(row) })
        expect(historyBtnOf('每日构建').getAttribute('aria-expanded')).toBe('true')
        expect(await screen.findByText('还没有任何执行记录')).toBeTruthy()

        await act(async () => { fireEvent.click(row) })
        expect(historyBtnOf('每日构建').getAttribute('aria-expanded')).toBe('false')
        expect(screen.queryByText('还没有任何执行记录')).toBeNull()
    })

    it('键盘可展开：行本体是原生 button（Tab 可达、Enter/Space 可激活）', () => {
        api.getConversations.mockResolvedValue({ok: true, data: []})
        setStore({schedules: [makeSchedule()]})
        render(<ScheduleDialog/>)

        const row = rowOf('每日构建') as HTMLButtonElement
        expect(row.tagName).toBe('BUTTON')
        expect(row.disabled).toBe(false)
        expect(row.getAttribute('tabindex')).not.toBe('-1')

        // 显式图标入口也可聚焦、且是唯一声明展开状态的地方
        const toggle = screen.getByRole('button', {name: '展开执行记录'})
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
    })

    it('同一时刻只允许展开一行', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: []})
        setStore({
            schedules: [
                makeSchedule({id: 's1', name: '甲任务'}),
                makeSchedule({id: 's2', name: '乙任务'}),
            ],
        })
        render(<ScheduleDialog/>)

        await act(async () => { fireEvent.click(rowOf('甲任务')) })
        expect(historyBtnOf('甲任务').getAttribute('aria-expanded')).toBe('true')

        await act(async () => { fireEvent.click(rowOf('乙任务')) })
        expect(historyBtnOf('乙任务').getAttribute('aria-expanded')).toBe('true')
        // 甲已自动收起：同一时刻只有一个展开区
        expect(historyBtnOf('甲任务').getAttribute('aria-expanded')).toBe('false')
        expect(screen.getAllByText('执行记录')).toHaveLength(1)
    })
})

describe('能力类任务：会话列表与跳转（B2）', () => {
    it('列出该任务的调度会话（标题 + preview），不再出现「会话列表搜索」', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: [conv()]})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        expect(await screen.findByText('每日构建 · 09:00')).toBeTruthy()
        expect(screen.getByText('抓到 3 条昨日进展')).toBeTruthy()
        expect(screen.queryByText(/会话列表/)).toBeNull()
    })

    it('点击整行投递给主进程打开该会话：调用 app.openConversation({conversationId, workspacePath})，不再内联渲染消息正文', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: [conv()]})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        const item = await screen.findByRole('button', {name: '打开会话：每日构建 · 09:00'})
        await act(async () => { fireEvent.click(item) })

        expect(api.openConversation).toHaveBeenCalledTimes(1)
        expect(api.openConversation).toHaveBeenCalledWith({conversationId: 'c1', workspacePath: 'E:/ws'})
        // 本窗口不就地激活（独立窗口的 store 从未加载会话，就地改只改到自己进程）
        expect(convStore.setActiveConversation).not.toHaveBeenCalled()
        // 消息正文改由会话页呈现：已删除的 conversationDetail 通道不再被调用
        expect(api.conversationDetail).not.toHaveBeenCalled()
    })

    it('行本体语义是「跳转」不是「展开」：原生 button、可 Tab、无 aria-expanded', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: [conv()]})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        const item = (await screen.findByRole('button', {name: '打开会话：每日构建 · 09:00'})) as HTMLButtonElement
        expect(item.tagName).toBe('BUTTON')
        expect(item.disabled).toBe(false)
        expect(item.getAttribute('tabindex')).not.toBe('-1')
        expect(item.getAttribute('aria-expanded')).toBeNull()
        expect(item.getAttribute('data-name')).toBe('schedule-dialog-conversation-button')
    })

    it('跳转成功（ok:true）：不出现任何提示（工作目录由主窗口切换，无需解释）', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: [conv({workspacePath: 'E:/ws'})]})
        api.openConversation.mockResolvedValue({ok: true})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', {name: '打开会话：每日构建 · 09:00'}))
        })

        expect(api.openConversation).toHaveBeenCalledWith({conversationId: 'c1', workspacePath: 'E:/ws'})
        expect(screen.queryByText(/打开会话失败/)).toBeNull()
        expect(screen.queryByText(/不在当前工作目录/)).toBeNull()
    })

    it('跳转失败（ok:false）：给出可读原因', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: [conv({workspacePath: 'E:/ws'})]})
        api.openConversation.mockResolvedValue({ok: false, error: '主窗口未响应'})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', {name: '打开会话：每日构建 · 09:00'}))
        })

        expect(await screen.findByText('打开会话失败：主窗口未响应')).toBeTruthy()
    })

    it('会话没有归属工作目录（workspacePath 为空）：照常投递空路径，由主进程判非法并如实提示', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: [conv({workspacePath: ''})]})
        api.openConversation.mockResolvedValue({ok: false, error: 'workspacePath 非法'})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', {name: '打开会话：每日构建 · 09:00'}))
        })

        expect(api.openConversation).toHaveBeenCalledWith({conversationId: 'c1', workspacePath: ''})
        expect(await screen.findByText('打开会话失败：workspacePath 非法')).toBeTruthy()
    })

    it('加载中：给出加载呈现', async () => {
        api.getConversations.mockReturnValue(new Promise(() => {}))
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })
        expect(screen.getByText('加载执行记录...')).toBeTruthy()
    })

    it('加载失败：给出可读原因与重试入口，与「还没有记录」措辞不同', async () => {
        api.getConversations.mockResolvedValue({ok: false, error: '无法读取该任务的调度会话（权限不足）'})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        expect(await screen.findByText(/执行记录加载失败：无法读取该任务的调度会话（权限不足）/)).toBeTruthy()
        expect(screen.queryByText('还没有任何执行记录')).toBeNull()

        const retry = screen.getByRole('button', {name: '重新加载执行记录'})
        await act(async () => { fireEvent.click(retry) })
        expect(api.getConversations).toHaveBeenCalledTimes(2)
    })

    it('还没有执行记录：说明文案与失败态完全不同', async () => {
        api.getConversations.mockResolvedValue({ok: true, data: []})
        setStore({schedules: [makeSchedule({taskType: 'agent'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        expect(await screen.findByText('还没有任何执行记录')).toBeTruthy()
        expect(screen.queryByText(/加载失败/)).toBeNull()
    })
})

describe('脚本类任务：日志列表与全文（B3）', () => {
    const logEntry = {path: 'E:/logs/a.log', fileName: 'a.log', startTime: Date.now(), size: 1024}

    it('列出日志并可就地读取全文', async () => {
        api.scriptLogs.mockResolvedValue({ok: true, data: [logEntry]})
        api.readScriptLog.mockResolvedValue({ok: true, data: {content: 'archive: done in 4.21s', totalSize: 20}})
        setStore({schedules: [makeSchedule({taskType: 'script'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        const view = await screen.findByRole('button', {name: '查看这次执行的日志全文'})
        await act(async () => { fireEvent.click(view) })
        expect(await screen.findByText('archive: done in 4.21s')).toBeTruthy()
    })

    it('加载失败给出可读原因与重试，而不是伪装成「暂无记录」', async () => {
        api.scriptLogs.mockResolvedValue({ok: false, error: '日志目录不可读'})
        setStore({schedules: [makeSchedule({taskType: 'script'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        expect(await screen.findByText('日志目录不可读')).toBeTruthy()
        expect(screen.queryByText('暂无脚本执行记录')).toBeNull()

        const retry = screen.getByRole('button', {name: '重新加载脚本执行记录'})
        await act(async () => { fireEvent.click(retry) })
        expect(api.scriptLogs).toHaveBeenCalledTimes(2)
    })

    it('抛异常时同样留下可读原因，不回退成空态', async () => {
        api.scriptLogs.mockRejectedValue(new Error('IPC 断开'))
        setStore({schedules: [makeSchedule({taskType: 'script'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        expect(await screen.findByText('IPC 断开')).toBeTruthy()
        expect(screen.queryByText('暂无脚本执行记录')).toBeNull()
    })

    it('暂无记录：与失败态措辞不同', async () => {
        api.scriptLogs.mockResolvedValue({ok: true, data: []})
        setStore({schedules: [makeSchedule({taskType: 'script'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })

        expect(await screen.findByText('暂无脚本执行记录')).toBeTruthy()
        expect(screen.queryByText(/加载失败/)).toBeNull()
    })

    it('日志过大：明确告知并标注被截断的部分', async () => {
        api.scriptLogs.mockResolvedValue({ok: true, data: [logEntry]})
        // 主进程按读取上限截断后才回传：content 是被截断的副本，totalSize 是文件真实大小 ——
        // 「共 Y」必须取自 totalSize，不能由渲染层数 content 的长度（那样永远等于「已读全」）。
        api.readScriptLog.mockResolvedValue({ok: true, data: {content: 'y'.repeat(300_001), totalSize: 5_000_000}})
        setStore({schedules: [makeSchedule({taskType: 'script'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', {name: '查看这次执行的日志全文'}))
        })

        const notice = await screen.findByText(/内容过大，仅显示前/)
        expect(notice.textContent).toContain('共')
        // 「共 Y」取自 main 上报的文件真实大小（5_000_000 B ≈ 4.8MB），而非收到的字符串长度
        expect(notice.textContent).toContain('4.8MB')
        expect(notice.getAttribute('data-name')).toBe('schedule-dialog-log-truncated-notice')
    })

    it('日志读取失败：给出可读原因，不只写「读取失败」四个字', async () => {
        api.scriptLogs.mockResolvedValue({ok: true, data: [logEntry]})
        api.readScriptLog.mockResolvedValue({ok: false, error: '文件已被删除'})
        setStore({schedules: [makeSchedule({taskType: 'script'})]})
        render(<ScheduleDialog/>)

        await act(async () => { expandFirstRow() })
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', {name: '查看这次执行的日志全文'}))
        })

        expect(await screen.findByText('文件已被删除')).toBeTruthy()
    })
})
