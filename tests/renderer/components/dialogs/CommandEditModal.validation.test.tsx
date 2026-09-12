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
