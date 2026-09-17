// @vitest-environment jsdom
/**
 * 定时任务编辑弹窗 · 保存失败不关窗（ui-05）
 *
 * 硬要求（不可让步）：失败不关窗 + 原因可见 + 表单内容保留。
 * 口径：渲染真实弹窗，断言用户能看到什么、点了会发生什么。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleResult} from '@shared/types/schedule'

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        // list 必须给足：复核 B1 后「列表未就绪」不再放行保存（本文件的用例考的是写失败回声）
        workspace: {
            getCurrent: vi.fn().mockResolvedValue(null),
            list: vi.fn().mockResolvedValue([{id: 'ws-1', name: '主工作区', path: 'E:/ws1'}]),
        },
        capability: {query: vi.fn().mockResolvedValue([]), onCapabilityChanged: vi.fn(() => () => {})},
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const editInitial = {
    id: 's1',
    name: '每日构建',
    description: '',
    taskType: 'agent' as const,
    taskTarget: 'code-reviewer',
    taskPrompt: '',
    cronExpression: '0 9 * * *',
    enabled: true,
    // 票 11 起工作目录必填：本文件的用例考的是写失败回声，故给一个非空值让保存能走到 onSave
    workspaceId: 'ws-1',
}

/**
 * 等工作区列表取回再动手。
 * 复核整改（B1）后「列表未就绪」**不再放行**保存（手里没有列表就无从校验工作目录），
 * 而列表是挂载后异步取回的 —— 本文件的用例考的是写失败回声，故必须先等它就绪。
 */
async function waitWorkspacesReady() {
    await waitFor(() => expect((screen.getByLabelText('工作目录') as HTMLButtonElement).disabled).toBe(false))
}

describe('ScheduleEditModal · 保存失败回声', () => {
    it('编辑失败：弹窗不关、原因可见、刚填的内容还在', async () => {
        const onSave = vi.fn(async () => ({ok: false, error: '存储异常（update）：db closed'} as const))
        const onClose = vi.fn()
        render(<ScheduleEditModal initial={editInitial} onSave={onSave} onClose={onClose}/>)

        const nameInput = screen.getByPlaceholderText('例如: 每日代码审查') as HTMLInputElement
        fireEvent.change(nameInput, {target: {value: '改过的名字'}})
        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('编辑失败')
        expect(alert.textContent).toContain('存储异常（update）：db closed')

        // 不关窗：弹窗节点仍在；且父层没有被通知关闭
        expect(document.querySelector('[data-name="schedule-edit-modal-div"]')).toBeTruthy()
        expect(onClose).not.toHaveBeenCalled()
        // 表单内容保留
        expect(nameInput.value).toBe('改过的名字')
    })

    it('新建失败：说的是「新建失败」而不是「编辑失败」（操作名要看得出来）', async () => {
        const onSave = vi.fn(async () => ({ok: false, error: 'cron 表达式非法：0 9 *'} as const))
        render(<ScheduleEditModal initial={{...editInitial, id: undefined}} onSave={onSave} onClose={vi.fn()}/>)

        // 新建路径的初值（「当前工作目录」）是异步回填的：复核 S1 后未就绪时保存按钮置灰，
        // 故先等它就绪再点 —— 这里等的是按钮可用，不是某个固定时长。
        await waitFor(() => expect((screen.getByRole('button', {name: '保存'}) as HTMLButtonElement).disabled).toBe(false))
        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('新建失败')
        expect(alert.textContent).toContain('cron 表达式非法：0 9 *')
    })

    it('父层抛异常（桥接层炸了）→ 同样留在窗前显示原因，不冒泡', async () => {
        const onSave = vi.fn(async (): Promise<ScheduleResult<unknown>> => { throw new Error('ipc broken') })
        render(<ScheduleEditModal initial={editInitial} onSave={onSave} onClose={vi.fn()}/>)

        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('编辑失败：ipc broken')
    })

    it('提交中：保存按钮置灰并改文案，避免连点重复提交', async () => {
        let resolveSave: (v: ScheduleResult<unknown>) => void = () => {}
        const onSave = vi.fn(() => new Promise<ScheduleResult<unknown>>(resolve => { resolveSave = resolve }))
        render(<ScheduleEditModal initial={editInitial} onSave={onSave} onClose={vi.fn()}/>)

        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))

        expect(screen.getByRole('button', {name: '保存中…'})).toBeTruthy()
        expect((screen.getByRole('button', {name: '保存中…'}) as HTMLButtonElement).disabled).toBe(true)

        await act(async () => {
            resolveSave({ok: false, error: 'boom'})
        })
        await waitFor(() => expect(screen.getByRole('button', {name: '保存'})).toBeTruthy())
        expect(screen.getByRole('alert').textContent).toContain('编辑失败：boom')
    })

    it('保存成功：不显示任何失败回声（关窗由父层负责）', async () => {
        const onSave = vi.fn(async () => ({ok: true, data: null} as const))
        render(<ScheduleEditModal initial={editInitial} onSave={onSave} onClose={vi.fn()}/>)

        await waitWorkspacesReady()
        await act(async () => {
            fireEvent.click(screen.getByText('保存'))
        })

        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('本地校验失败（没填名字）与写失败共用同一个可播报区域，但文案各自可辨', async () => {
        const onSave = vi.fn(async () => ({ok: false, error: 'x'} as const))
        render(<ScheduleEditModal initial={{...editInitial, name: ''}} onSave={onSave} onClose={vi.fn()}/>)

        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toBe('任务名称不能为空')
        expect(onSave).not.toHaveBeenCalled()
    })

    it('本地校验失败不被上一次的写失败回声遮蔽，且 live region 文本确实变化（读屏会重播）', async () => {
        const onSave = vi.fn(async () => ({ok: false, error: 'db closed'} as const))
        render(<ScheduleEditModal initial={editInitial} onSave={onSave} onClose={vi.fn()}/>)

        // ① 先制造一次写失败
        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))
        const firstText = (await screen.findByRole('alert')).textContent
        expect(firstText).toBe('编辑失败：db closed')

        // ② 清空名称再提交：本地校验会在调用 onSave 之前提前 return
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: ''}})
        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))

        const second = await screen.findByRole('alert')
        // 呈现的必须是校验文案，且不含旧的服务端错误
        expect(second.textContent).toBe('任务名称不能为空')
        expect(second.textContent).not.toContain('db closed')
        // 两次文本不同 → 读屏会重新播报，校验失败不是静默
        expect(second.textContent).not.toBe(firstText)
        // 校验失败时 onSave 根本没被再次调用（第一次的 1 次仍是 1 次）
        expect(onSave).toHaveBeenCalledTimes(1)
    })

    it('改动任一表单字段后，上一次的写失败回声立即消失（历史错误不长期滞留）', async () => {
        const onSave = vi.fn(async () => ({ok: false, error: 'db closed'} as const))
        render(<ScheduleEditModal initial={editInitial} onSave={onSave} onClose={vi.fn()}/>)

        await waitWorkspacesReady()
        fireEvent.click(screen.getByText('保存'))
        expect((await screen.findByRole('alert')).textContent).toBe('编辑失败：db closed')

        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '改过了'}})

        expect(screen.queryByRole('alert')).toBeNull()
    })
})
