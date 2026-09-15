// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {CommandEditModal} from '../../../../src/renderer/components/dialogs/CommandEditModal'

// ── 依赖 mock ──────────────────────────────────────────
// CommandEditModal 通过 useUserCommandStore 读取 createCommand/updateCommand。
// 沿用 ScheduleEditModal.capability.test.tsx 的 mock 模式：hook + getState。

const {mockStoreState} = vi.hoisted(() => {
    return {
        mockStoreState: {
            commands: [],
            createCommand: vi.fn().mockResolvedValue({success: true}),
            updateCommand: vi.fn().mockResolvedValue({success: true}),
            loadCommands: vi.fn().mockResolvedValue(undefined),
        },
    }
})

vi.mock('../../../../src/renderer/stores/userCommandStore', () => {
    const hook = (selector?: (s: any) => unknown) => (selector ? selector(mockStoreState) : mockStoreState)
    ;(hook as any).getState = () => mockStoreState
    return {useUserCommandStore: hook}
})

beforeEach(() => {
    vi.stubGlobal('electronAPI', {})
    mockStoreState.createCommand.mockClear()
    mockStoreState.updateCommand.mockClear()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function getNameInput(): HTMLInputElement {
    return document.querySelector('[data-name="command-edit-modal-input"]') as HTMLInputElement
}

describe('CommandEditModal 名称校验', () => {
    it('中文命令名可以保存，且不显示错误', async () => {
        const onSave = vi.fn()
        render(<CommandEditModal command={null} onSave={onSave} onCancel={vi.fn()}/>)

        fireEvent.change(getNameInput(), {target: {value: '日报'}})
        fireEvent.change(screen.getByPlaceholderText(/命令模板/), {target: {value: '请写今日日报'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(mockStoreState.createCommand).toHaveBeenCalledTimes(1))
        expect(mockStoreState.createCommand.mock.calls[0][0].name).toBe('日报')
        expect(onSave).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('非法名称（含空格）报红字并高亮输入框', async () => {
        const onSave = vi.fn()
        render(<CommandEditModal command={null} onSave={onSave} onCancel={vi.fn()}/>)

        fireEvent.change(getNameInput(), {target: {value: 'daily report'}})
        fireEvent.change(screen.getByPlaceholderText(/命令模板/), {target: {value: '内容'}})
        fireEvent.click(screen.getByText('保存'))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('命令名称只能包含中英文、数字、下划线或连字符')
        expect(alert.className).toContain('text-[var(--error)]')
        expect(getNameInput().className).toContain('border-[var(--error)]')
        expect(mockStoreState.createCommand).not.toHaveBeenCalled()
        expect(onSave).not.toHaveBeenCalled()
    })
})

describe('CommandEditModal 新建撞名即时提示', () => {
    const existing = ['daily', '日报']

    it('输入已存在的名称 → 立即内联报错，无需提交', () => {
        render(<CommandEditModal command={null} existingNames={existing} onSave={vi.fn()} onCancel={vi.fn()}/>)

        fireEvent.change(getNameInput(), {target: {value: 'daily'}})

        const alert = screen.getByRole('alert')
        expect(alert.textContent).toBe('已存在同名命令，请修改命令名')
        expect(getNameInput().className).toContain('border-[var(--error)]')
        expect(mockStoreState.createCommand).not.toHaveBeenCalled()
    })

    it('查重大小写不敏感（Daily 命中 daily）', () => {
        render(<CommandEditModal command={null} existingNames={existing} onSave={vi.fn()} onCancel={vi.fn()}/>)
        fireEvent.change(getNameInput(), {target: {value: 'Daily'}})
        expect(screen.getByRole('alert').textContent).toBe('已存在同名命令，请修改命令名')
    })

    it('名称不重复 → 无错误', () => {
        render(<CommandEditModal command={null} existingNames={existing} onSave={vi.fn()} onCancel={vi.fn()}/>)
        fireEvent.change(getNameInput(), {target: {value: 'brand-new'}})
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('撞名时点击保存 → 前端拦截，不调用 createCommand', async () => {
        const onSave = vi.fn()
        render(<CommandEditModal command={null} existingNames={existing} onSave={onSave} onCancel={vi.fn()}/>)

        fireEvent.change(getNameInput(), {target: {value: 'daily'}})
        fireEvent.change(screen.getByPlaceholderText(/命令模板/), {target: {value: '内容'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('已存在同名命令，请修改命令名'))
        expect(mockStoreState.createCommand).not.toHaveBeenCalled()
        expect(onSave).not.toHaveBeenCalled()
    })

    it('编辑模式排除自身原名 → 保持原名不报错', () => {
        const editing = {id: 'user:daily', name: 'daily', content: 'BODY', enabled: true} as any
        render(<CommandEditModal command={editing} existingNames={existing} onSave={vi.fn()} onCancel={vi.fn()}/>)
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('编辑模式改名为另一个已有命令 → 报错', () => {
        const editing = {id: 'user:daily', name: 'daily', content: 'BODY', enabled: true} as any
        render(<CommandEditModal command={editing} existingNames={existing} onSave={vi.fn()} onCancel={vi.fn()}/>)

        fireEvent.change(getNameInput(), {target: {value: '日报'}})
        expect(screen.getByRole('alert').textContent).toBe('已存在同名命令，请修改命令名')
    })
})

describe('CommandEditModal 后端错误回显（纵深防御）', () => {
    it('主进程返回撞名错误时仍展示（不因前端校验而假设后端不拒绝）', async () => {
        mockStoreState.createCommand.mockResolvedValueOnce({success: false, error: '已存在同名命令，请修改命令名'})
        render(<CommandEditModal command={null} onSave={vi.fn()} onCancel={vi.fn()}/>)

        fireEvent.change(getNameInput(), {target: {value: 'free'}})
        fireEvent.change(screen.getByPlaceholderText(/命令模板/), {target: {value: '内容'}})
        fireEvent.click(screen.getByText('保存'))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('已存在同名命令，请修改命令名')
    })
})
