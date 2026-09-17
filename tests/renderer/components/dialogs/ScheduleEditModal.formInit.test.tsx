// @vitest-environment jsdom
/**
 * ScheduleEditModal · 初值回填（票 11 复核整改 R9 / S1 / S2）
 *
 * 三条口径各自可失败地钉住：
 *  - **R9**：`initial` 对象身份每次渲染都变（父层写的是字面量），旧实现以 `[initial]` 为依赖
 *    → 父层任何一次重渲染都重跑回填，用户输入的名字与选好的工作目录被**静默还原**。
 *    本票新增的健康度广播又显著抬高了父层重渲染频次，于是「重新选一个可用工作目录」的动作
 *    会在下一次广播后被打回失效值 —— 功能在真实环境直接不可用。
 *  - **S1**：初值（新建时的「当前工作目录」）还没落地就点保存 → 报「请选择工作目录」
 *    （用户没做过这个动作）。未就绪时保存按钮必须置灰并给出等待态。
 *  - **S2**：编辑一条 `workspaceId === null` 的存量任务时，`getCurrent()` 回填会把
 *    「用户完全没碰过」的字段静默改掉。编辑路径不回填，新建路径保留合理默认。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleFormData} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'

const WORKSPACES = [
    {id: 'ws-1', name: '主工作区', path: 'E:/ws1'},
    {id: 'ws-2', name: '备用工作区', path: 'E:/ws2'},
]

/** 当前工作区（异步回填的来源）；用例可换成「永不 resolve」以观察未就绪态 */
let currentImpl: () => Promise<{id: string; name: string; path: string} | null>

beforeEach(() => {
    currentImpl = async () => ({id: 'ws-2', name: '备用工作区', path: 'E:/ws2'})
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        workspace: {
            getCurrent: vi.fn(() => currentImpl()),
            list: vi.fn().mockResolvedValue(WORKSPACES),
        },
        capability: {query: vi.fn().mockResolvedValue([]), onCapabilityChanged: vi.fn(() => () => {})},
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const editInitial: Partial<ScheduleFormData> = {
    id: 's1',
    name: '原名字',
    description: '',
    taskType: 'agent',
    taskTarget: 'code-reviewer',
    taskPrompt: '',
    cronExpression: '0 9 * * *',
    enabled: true,
    workspaceId: 'ws-1',
}

const nameInput = () => screen.getByPlaceholderText('例如: 每日代码审查') as HTMLInputElement
const saveButton = () => screen.getByRole('button', {name: '保存'}) as HTMLButtonElement
const workspaceText = () => screen.getByLabelText('工作目录').textContent ?? ''

/** 排空微任务 + 让 React 处理由此产生的状态更新 */
async function flush() {
    await act(async () => { await Promise.resolve() })
}

/** 等下拉可用（= 工作区列表已取回）再展开它 */
async function openWorkspaceDropdown() {
    const trigger = screen.getByLabelText('工作目录') as HTMLButtonElement
    await waitFor(() => expect(trigger.disabled).toBe(false))
    fireEvent.click(trigger)
    return await screen.findByRole('listbox')
}

describe('R9：父层重渲染不得重置表单', () => {
    it('父层以「同值但**新对象**」的 initial 重渲染后：已输入的名字与已选的工作目录都保留', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        const {rerender} = render(
            <ScheduleEditModal initial={editInitial} onSave={onSave} onClose={vi.fn()}/>,
        )

        // 用户输入名字
        fireEvent.change(nameInput(), {target: {value: '用户改过的名字'}})
        // 用户显式换一个工作目录
        await openWorkspaceDropdown()
        fireEvent.click(screen.getByRole('option', {name: '备用工作区 (E:/ws2)'}))
        expect(workspaceText()).toContain('备用工作区 (E:/ws2)')

        // 父层重渲染：传一个同值的新对象（真实父层的写法：内联字面量 / 每次 render 重建）
        rerender(<ScheduleEditModal initial={{...editInitial}} onSave={onSave} onClose={vi.fn()}/>)

        // 表单还是用户填的样子（旧实现这里会被打回「原名字」与 ws-1）
        expect(nameInput().value).toBe('用户改过的名字')
        expect(workspaceText()).toContain('备用工作区 (E:/ws2)')
    })

    it('重渲染后保存，交给父层的仍是用户选的那个工作区与名字（被打回的值会直接落库）', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        const {rerender} = render(
            <ScheduleEditModal initial={editInitial} onSave={onSave} onClose={vi.fn()}/>,
        )

        fireEvent.change(nameInput(), {target: {value: '用户改过的名字'}})
        await openWorkspaceDropdown()
        fireEvent.click(screen.getByRole('option', {name: '备用工作区 (E:/ws2)'}))

        rerender(<ScheduleEditModal initial={{...editInitial}} onSave={onSave} onClose={vi.fn()}/>)
        fireEvent.click(saveButton())

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].workspaceId).toBe('ws-2')
        expect(onSave.mock.calls[0][0].name).toBe('用户改过的名字')
    })
})

describe('S2：编辑存量任务不回填工作目录，新建保留默认', () => {
    it('编辑一条本来就没有工作目录的任务：不回填当前工作区，显式要求用户选', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={{...editInitial, workspaceId: null}} onSave={onSave} onClose={vi.fn()}/>)

        // 让 getCurrent() 的 promise 有机会落地（回填若存在，此刻就会写进去）
        await flush()

        expect(workspaceText()).toContain('未设置工作目录（必选）')
        // 用户只改名字、完全没碰工作目录 → 保存必须被拦，而不是静默绑到 ws-2 上
        fireEvent.change(nameInput(), {target: {value: '只改名字'}})
        fireEvent.click(saveButton())
        expect((await screen.findByRole('alert')).textContent).toBe('请选择工作目录')
        expect(onSave).not.toHaveBeenCalled()
    })

    it('新建任务仍默认填当前工作区（保留合理默认）', async () => {
        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal onSave={onSave} onClose={vi.fn()}/>)

        await waitFor(() => expect(workspaceText()).toContain('备用工作区 (E:/ws2)'))

        fireEvent.change(nameInput(), {target: {value: '新建任务'}})
        fireEvent.click(screen.getByRole('button', {name: /本地脚本/}))
        fireEvent.change(screen.getByLabelText('脚本路径'), {target: {value: 'C:/s/a.ps1'}})

        await waitFor(() => expect(saveButton().disabled).toBe(false))
        fireEvent.click(saveButton())
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].workspaceId).toBe('ws-2')
    })
})

describe('S1：初值未就绪时保存按钮置灰，不报用户没做过的动作', () => {
    it('getCurrent() 未落地时：按钮禁用 + 等待态；落地后恢复可点并照常保存', async () => {
        let resolveCurrent: (v: {id: string; name: string; path: string} | null) => void = () => {}
        currentImpl = () => new Promise(resolve => { resolveCurrent = resolve })

        const onSave = vi.fn(async (_data: ScheduleFormData) => ({ok: true, data: null} as const))
        render(<ScheduleEditModal onSave={onSave} onClose={vi.fn()}/>)

        fireEvent.change(nameInput(), {target: {value: '新建任务'}})
        fireEvent.click(screen.getByRole('button', {name: /本地脚本/}))
        fireEvent.change(screen.getByLabelText('脚本路径'), {target: {value: 'C:/s/a.ps1'}})

        // 未就绪：按钮点不动，也不会报「请选择工作目录」（用户没做过这个动作）
        expect(saveButton().disabled).toBe(true)
        expect(document.querySelector('[data-name="schedule-edit-modal-initializing-hint"]')).toBeTruthy()
        fireEvent.click(saveButton())
        expect(screen.queryByRole('alert')).toBeNull()
        expect(onSave).not.toHaveBeenCalled()

        // 初值落地 → 按钮恢复可点，保存照常走
        await act(async () => { resolveCurrent({id: 'ws-1', name: '主工作区', path: 'E:/ws1'}) })
        await waitFor(() => expect(saveButton().disabled).toBe(false))
        expect(workspaceText()).toContain('主工作区 (E:/ws1)')
        fireEvent.click(saveButton())
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].workspaceId).toBe('ws-1')
    })

    it('编辑一条已有工作目录的任务：初值同步就绪，保存按钮立即可用（不引入多余等待）', () => {
        render(<ScheduleEditModal initial={editInitial} onSave={vi.fn()} onClose={vi.fn()}/>)
        expect(saveButton().disabled).toBe(false)
        expect(document.querySelector('[data-name="schedule-edit-modal-initializing-hint"]')).toBeNull()
    })
})
