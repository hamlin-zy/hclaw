// @vitest-environment jsdom
/**
 * 定时任务编辑弹窗 · 项目必填、失效占位与「列表未就绪不得放行」（票 11 · workspace-guard）
 *
 * 口径：渲染真实弹窗，断言**用户看到什么、点了会发生什么**。
 *   1. 下拉里不再有「默认项目」这一项（旧的可选项会把任务落到非注册目录上）；
 *   2. 当前值解析不到现存工作区时，以占位项把原值摆出来（已失效 / 未设置 / 待校验）；
 *   3. 保存被拦：原因可读、不关窗、表单不丢；改成有效项目即可正常保存。
 *
 * 复核整改（B1）新增的一节钉住「三态口径」：
 *   - 列表**未就绪 / 取数失败 / 空表**时：**拦**（不放行未校验的 id），提示说的是
 *     「无法校验」而**不是**「已失效」，并给一个显式的重试入口；
 *   - 列表**已取回**时：命中即放行，未命中即拦并明说「已失效」；
 *   - 同屏的内联提示与保存拦截文案必须一致（同一份 verdict 渲染两次），
 *     合法 id 永远不会被显示成「已失效」。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleFormData} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import {
    WORKSPACE_INVALID_MESSAGE,
    WORKSPACE_LIST_UNREADY_MESSAGE,
    WORKSPACE_UNSET_MESSAGE,
} from '../../../../src/renderer/components/dialogs/ScheduleUtils'

const WORKSPACES = [
    {id: 'ws-1', name: '主工作区', path: 'E:/ws1'},
    {id: 'ws-2', name: '备用工作区', path: 'E:/ws2'},
]

interface StubOpts {
    current?: {id: string; name: string; path: string} | null
    /** 工作区列表的返回值；`'throws'` = 这次取数失败（Promise reject） */
    list?: typeof WORKSPACES | 'throws' | 'missing'
}

function stubElectron(opts: StubOpts = {}) {
    const list = opts.list ?? WORKSPACES
    const listFn = list === 'missing'
        ? undefined
        : vi.fn(() => list === 'throws'
            ? Promise.reject(new Error('ipc broken'))
            : Promise.resolve(list))
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        workspace: {
            getCurrent: vi.fn().mockResolvedValue(opts.current ?? null),
            ...(listFn ? {list: listFn} : {}),
        },
        capability: {query: vi.fn().mockResolvedValue([]), onCapabilityChanged: vi.fn(() => () => {})},
    })
    return {listFn}
}

beforeEach(() => {
    stubElectron()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const base: Partial<ScheduleFormData> = {
    id: 's1',
    name: '每日构建',
    description: '',
    taskType: 'agent',
    taskTarget: 'code-reviewer',
    taskPrompt: '',
    cronExpression: '0 9 * * *',
    enabled: true,
    workspaceId: 'ws-1',
}

/**
 * 打开项目下拉并等它真的渲染出来（选项渲染 = 工作区列表已取回）。
 * 列表没到手时下拉是禁用态（B1：空面板没有意义），故先等它可用 —— 这个等待本身就是
 * 「就绪」这件事的可观察信号。
 */
async function openWorkspaceDropdown() {
    const trigger = screen.getByLabelText('项目') as HTMLButtonElement
    await waitFor(() => expect(trigger.disabled).toBe(false))
    fireEvent.click(trigger)
    return await screen.findByRole('listbox')
}

function closeDropdown() {
    fireEvent.keyDown(document, {key: 'Escape'})
}

/** 项目那一行的内联提示（不是 live region —— live region 全弹窗只有一处） */
const inlineNotice = () => document.querySelector('[data-name="schedule-edit-modal-workspace-warning"]')

/** 等内联提示出现并返回它的文案 */
async function inlineNoticeText(): Promise<string> {
    await waitFor(() => expect(inlineNotice()).toBeTruthy())
    return (inlineNotice()!.textContent ?? '').trim()
}

/** 点保存并返回 live region（role="alert"）的文案 */
async function clickSaveAndReadAlert() {
    fireEvent.click(screen.getByText('保存'))
    const alert = await screen.findByRole('alert')
    return (alert.textContent ?? '').trim()
}

describe('项目下拉：不再有「默认项目」', () => {
    it('列表里只有现存工作区，没有「默认项目」，也没有空值项', async () => {
        render(<ScheduleEditModal initial={base} onSave={vi.fn()} onClose={vi.fn()}/>)
        await openWorkspaceDropdown()

        expect(screen.queryByText('默认项目')).toBeNull()
        const options = screen.getAllByRole('option')
        expect(options.map(o => o.textContent)).toEqual(['主工作区 (E:/ws1)', '备用工作区 (E:/ws2)'])
        // 当前值就是 ws-1：触发按钮上显示的是它，而不是兜底文案
        expect(screen.getByLabelText('项目').textContent).toContain('主工作区 (E:/ws1)')
    })

    it('未设置项目：触发按钮给出必选提示，列表里以禁用占位显示现状', async () => {
        render(<ScheduleEditModal initial={{...base, workspaceId: null}} onSave={vi.fn()} onClose={vi.fn()}/>)

        // 不静默留白：按钮上明说「未设置项目（必选）」
        expect(screen.getByLabelText('项目').textContent).toContain('未设置项目（必选）')

        await openWorkspaceDropdown()
        const placeholder = screen.getByRole('option', {name: '未设置项目'}) as HTMLButtonElement
        expect(placeholder.disabled).toBe(true)
        expect(screen.queryByText('默认项目')).toBeNull()
    })

    it('失效的 workspaceId：占位项显示原值并标注已失效，而不是显示为空', async () => {
        render(
            <ScheduleEditModal initial={{...base, workspaceId: 'ws-a0b1dd77-不存在'}}
                               onSave={vi.fn()} onClose={vi.fn()}/>,
        )

        // 触发按钮上就能看到原值 + 已失效（不用展开也知道现状）
        await waitFor(() => expect(screen.getByLabelText('项目').textContent)
            .toContain('项目已失效（原值：ws-a0b1dd77-不存在）'))
        expect(await inlineNoticeText()).toBe(WORKSPACE_INVALID_MESSAGE)

        await openWorkspaceDropdown()
        const placeholder = screen.getByRole('option', {name: /项目已失效/}) as HTMLButtonElement
        expect(placeholder.disabled).toBe(true)
        // 占位项点不动：它是「现状说明」，不是一条可选路径
        fireEvent.click(placeholder)
        expect(screen.getByLabelText('项目').textContent).toContain('ws-a0b1dd77-不存在')
    })
})

describe('保存校验：项目必填且必须解析得到现存工作区', () => {
    it('未设置项目 → 拦在弹窗内，给出原因，不关窗、不丢表单', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        const onClose = vi.fn()
        render(<ScheduleEditModal initial={{...base, workspaceId: null}} onSave={onSave} onClose={onClose}/>)

        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '改过的名字'}})
        // 先等列表取回：本用例考的是「列表在手 + 没选」这一档（列表未就绪是另一档，另行覆盖）
        await waitFor(() => expect((screen.getByLabelText('项目') as HTMLButtonElement).disabled).toBe(false))

        expect(await clickSaveAndReadAlert()).toBe(WORKSPACE_UNSET_MESSAGE)
        expect(onSave).not.toHaveBeenCalled()
        expect(document.querySelector('[data-name="schedule-edit-modal-div"]')).toBeTruthy()
        expect(onClose).not.toHaveBeenCalled()
        expect((screen.getByPlaceholderText('例如: 每日代码审查') as HTMLInputElement).value).toBe('改过的名字')
    })

    it('项目已失效 → 拦下并说明是「失效」而不是「没选」', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={{...base, workspaceId: 'ws-a0b1dd77-不存在'}}
                                  onSave={onSave} onClose={vi.fn()}/>)

        // 先等下拉真的加载出工作区列表（否则「失效」判定无从谈起）
        await openWorkspaceDropdown()
        closeDropdown()

        expect(await clickSaveAndReadAlert()).toBe(WORKSPACE_INVALID_MESSAGE)
        expect(onSave).not.toHaveBeenCalled()
        expect(document.querySelector('[data-name="schedule-edit-modal-div"]')).toBeTruthy()
    })

    it('改成有效项目后保存成功：交给父层的是新工作区 id', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={{...base, workspaceId: 'ws-a0b1dd77-不存在'}}
                                  onSave={onSave} onClose={vi.fn()}/>)

        await openWorkspaceDropdown()
        fireEvent.click(screen.getByRole('option', {name: '备用工作区 (E:/ws2)'}))

        // 换成有效工作区后，失效占位与提示都消失
        expect(screen.getByLabelText('项目').textContent).toContain('备用工作区 (E:/ws2)')
        expect(screen.queryByText(WORKSPACE_INVALID_MESSAGE)).toBeNull()

        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].workspaceId).toBe('ws-2')
        expect(screen.queryByRole('alert')).toBeNull()
    })
})

/**
 * 复核 B1：列表没到手时的三态口径。
 * 这四种组合（取数失败 + 合法 id / 取数失败 + 失效 id / 空表 / 已取回且命中）
 * 必须做到「内联提示」与「保存是否放行」两件事同结论。
 */
describe('列表未就绪不得放行，也不得冒充「已失效」（B1）', () => {
    it('取数失败 + **合法** id：说「无法校验」而不是「已失效」，保存被拦，并给出重试入口', async () => {
        stubElectron({list: 'throws'})
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={base} onSave={onSave} onClose={vi.fn()}/>)

        expect(await inlineNoticeText()).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        // 合法 id 绝不被显示成「已失效」（旧实现在这里正好说反了）
        expect(screen.queryByText(/项目已失效/)).toBeNull()
        expect(screen.getByLabelText('项目').textContent).not.toContain('已失效')

        // 同屏两处文案一致：内联提示 == 保存拦截
        const alertText = await clickSaveAndReadAlert()
        expect(alertText).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        expect(alertText).toBe(await inlineNoticeText())
        expect(onSave).not.toHaveBeenCalled()

        // 显式重试入口：桥修好后重试 → 提示消失、保存放行
        const retry = screen.getByRole('button', {name: '重试加载项目列表'})
        ;(window as unknown as {electronAPI: {workspace: {list: unknown}}}).electronAPI.workspace.list =
            vi.fn().mockResolvedValue(WORKSPACES)
        await act(async () => { fireEvent.click(retry) })

        await waitFor(() => expect(inlineNotice()).toBeNull())
        expect(screen.queryByRole('button', {name: '重试加载项目列表'})).toBeNull()
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].workspaceId).toBe('ws-1')
    })

    it('取数失败 + **失效** id：同样说「无法校验」（没有列表就不给「已失效」这个结论）', async () => {
        stubElectron({list: 'throws'})
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={{...base, workspaceId: 'ws-a0b1dd77-不存在'}}
                                  onSave={onSave} onClose={vi.fn()}/>)

        expect(await inlineNoticeText()).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        expect(screen.queryByText(/已失效/)).toBeNull()
        expect(await clickSaveAndReadAlert()).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        expect(onSave).not.toHaveBeenCalled()
    })

    it('桥接缺失（window.electronAPI.workspace.list 不存在）：拦住 + 重试入口，不炸', async () => {
        stubElectron({list: 'missing'})
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={base} onSave={onSave} onClose={vi.fn()}/>)

        expect(await inlineNoticeText()).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        expect(await clickSaveAndReadAlert()).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        expect(onSave).not.toHaveBeenCalled()
        expect(screen.getByRole('button', {name: '重试加载项目列表'})).toBeTruthy()
    })

    it('列表取回但**为空**：同样拦住（空表里任何 id 都不可能「现存」）', async () => {
        stubElectron({list: []})
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={base} onSave={onSave} onClose={vi.fn()}/>)

        expect(await inlineNoticeText()).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        expect(await clickSaveAndReadAlert()).toBe(WORKSPACE_LIST_UNREADY_MESSAGE)
        expect(onSave).not.toHaveBeenCalled()
    })

    it('列表已取回且**命中**：内联无提示错误、保存放行（与上面三态不冲突）', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={base} onSave={onSave} onClose={vi.fn()}/>)

        // 等列表取回（此时内联提示从「未就绪」变成常规说明 —— 有无 warning 节点即分界）
        await openWorkspaceDropdown()
        closeDropdown()
        await waitFor(() => expect(inlineNotice()).toBeNull())

        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].workspaceId).toBe('ws-1')
    })
})
