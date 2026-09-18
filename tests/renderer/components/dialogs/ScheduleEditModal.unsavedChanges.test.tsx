// @vitest-environment jsdom
/**
 * 编辑弹窗 · 关闭前的未保存提醒（ui-09，§6 #18）
 *
 * 三条关闭路径（Esc / 右上角 X / 底部「取消」）必须走**同一条**判断：
 *  - 没有任何改动 → 直接关窗，不打扰；
 *  - 有未保存改动 → 先问一句，选「继续编辑」不关窗、选「放弃改动」才关窗；
 *  - 提醒框已经开着的时候再按 Esc，不得叠出第二层提醒（Esc 应当只关掉提醒框本身）。
 *
 * `confirm` 是模块级单例（window 事件驱动），测试里把它 mock 成「由用例决定用户点了什么」。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleFormData} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'

const h = vi.hoisted(() => ({confirm: vi.fn()}))

vi.mock('../../../../src/renderer/components/ConfirmDialog', () => ({
    confirm: h.confirm,
    default: () => null,
}))

const capEntry = (name: string, type: 'skill' | 'agent' | 'command', description: string) => ({
    id: name,
    name,
    description,
    type,
    source: 'builtin',
    enabled: true,
    searchText: name.toLowerCase(),
})

const {capabilityQuery} = vi.hoisted(() => ({capabilityQuery: vi.fn()}))

beforeEach(() => {
    h.confirm.mockReset()
    capabilityQuery.mockReset()
    capabilityQuery.mockImplementation(async () => [capEntry('code-reviewer', 'agent', '代码审查')])
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        workspace: {getCurrent: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([])},
        capability: {query: capabilityQuery, onCapabilityChanged: vi.fn(() => () => {})},
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const editInitial: Partial<ScheduleFormData> = {
    id: 's1',
    name: '每日构建',
    description: '',
    taskType: 'agent',
    taskTarget: 'code-reviewer',
    taskPrompt: '',
    cronExpression: '0 9 * * *',
    enabled: true,
    workspaceId: null,
}

async function renderModal() {
    const onClose = vi.fn()
    render(<ScheduleEditModal initial={editInitial} onSave={vi.fn(async () => ({ok: true, data: null}) as const)} onClose={onClose}/>)
    await waitFor(() => expect(screen.getByText('code-reviewer')).toBeTruthy(), {timeout: 3000})
    return {onClose}
}

const esc = () => fireEvent.keyDown(document, {key: 'Escape'})

describe('Esc 关闭编辑窗口（H6）', () => {
    it('没有任何改动时按 Esc：直接关窗，不弹提醒', async () => {
        const {onClose} = await renderModal()

        esc()

        expect(onClose).toHaveBeenCalledTimes(1)
        expect(h.confirm).not.toHaveBeenCalled()
    })
})

describe('关闭前的未保存提醒（§6 #18）', () => {
    it('改过表单后按 Esc：先提醒；选「继续编辑」不关窗', async () => {
        const {onClose} = await renderModal()
        fireEvent.change(screen.getByLabelText('任务名称'), {target: {value: '改过的名字'}})
        h.confirm.mockResolvedValue(false)

        esc()

        await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))
        expect(h.confirm.mock.calls[0][0].message).toContain('未保存')
        expect(onClose).not.toHaveBeenCalled()
    })

    it('改过表单后按 Esc：选「放弃改动」才关窗', async () => {
        const {onClose} = await renderModal()
        fireEvent.change(screen.getByLabelText('任务名称'), {target: {value: '改过的名字'}})
        h.confirm.mockResolvedValue(true)

        esc()

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    })

    it('右上角 X 与底部「取消」走同一条提醒路径', async () => {
        const {onClose} = await renderModal()
        fireEvent.change(screen.getByLabelText('任务名称'), {target: {value: '改过的名字'}})
        h.confirm.mockResolvedValue(false)

        fireEvent.click(screen.getByRole('button', {name: '关闭'}))
        await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))

        fireEvent.click(screen.getByRole('button', {name: '取消'}))
        await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(2))

        expect(onClose).not.toHaveBeenCalled()
    })

    it('提醒框已开着时再按 Esc：不会叠出第二层提醒', async () => {
        const {onClose} = await renderModal()
        fireEvent.change(screen.getByLabelText('任务名称'), {target: {value: '改过的名字'}})
        // 用户的决定尚未落下（弹窗还开着）
        let resolvePrompt: (v: boolean) => void = () => {}
        h.confirm.mockImplementation(() => new Promise<boolean>(r => { resolvePrompt = r }))

        esc()
        await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))

        // 这一下 Esc 是给提醒框的（ConfirmDialog 自己处理），不得再次开门
        esc()
        expect(h.confirm).toHaveBeenCalledTimes(1)

        // 用户随后选了「放弃改动」→ 才真的关窗
        resolvePrompt(true)
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    })

    it('新建任务未填任何内容时按 Esc：不弹提醒（没有可丢的改动）', async () => {
        const onClose = vi.fn()
        render(<ScheduleEditModal onSave={vi.fn()} onClose={onClose}/>)
        await waitFor(() => expect(screen.getByText('code-reviewer')).toBeTruthy(), {timeout: 3000})

        esc()

        expect(h.confirm).not.toHaveBeenCalled()
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})

/**
 * dirty 只在**有实质改动**时置位（ui-09 复核整改 A3）。
 *
 * 复核实测的误报：点「已经是选中态」的 cron 页签 / 模式按钮后再按 Esc，会弹出
 * 「放弃未保存的改动？」，而表单其实一个字段都没变。这些用例把「无改动」的三种
 * 典型交互钉死为「不打扰」，同时保留「真改了就要提醒」的反向证据。
 */
describe('无实质改动不置脏（A3）', () => {
    /** cron 折叠区的展开按钮（其可访问名以「频率:」开头） */
    const cronToggle = () => screen.getByRole('button', {name: /^频率:/})
    const byName = (name: string) => document.querySelector(`[data-name="${name}"]`) as HTMLElement

    it('点已经是选中态的模式按钮（可用能力）后按 Esc：不弹提醒，直接关窗', async () => {
        const {onClose} = await renderModal()

        fireEvent.click(byName('schedule-edit-modal-capability-mode-button'))

        esc()

        expect(h.confirm).not.toHaveBeenCalled()
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('点已经是选中态的 cron 页签（每天）后按 Esc：不弹提醒', async () => {
        const {onClose} = await renderModal()

        fireEvent.click(cronToggle())                      // 展开频率面板（展开本身不算改动）
        fireEvent.click(byName('schedule-edit-modal-cron-tab-0'))   // 「每天」，当前就是选中态

        esc()

        expect(h.confirm).not.toHaveBeenCalled()
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('点「每月」里已经是选中态的那个日期后按 Esc：不弹提醒', async () => {
        // 为什么用日期网格而不是数字输入框：React 的 value tracker 会把「把输入框改成它
        // 原有的值」这条路径整个吃掉（原生值没变 → 合成 change 不派发），那样的用例
        // 拿不到证据（实现有没有去重它都绿）。日期格子是**幂等设置**（点击即
        // `updateCron({monthlyDate: d})`），点已选中的那格会真实地把等价值再传一次。
        const onClose = vi.fn()
        render(<ScheduleEditModal
            initial={{...editInitial, cronExpression: '0 9 1 * *'}}   // 初值即「每月 1 日 09:00」
            onSave={vi.fn(async () => ({ok: true, data: null}) as const)}
            onClose={onClose}/>)
        await waitFor(() => expect(screen.getByText('code-reviewer')).toBeTruthy(), {timeout: 3000})

        fireEvent.click(cronToggle())
        fireEvent.click(byName('schedule-edit-modal-monthly-date-1'))  // 点已选中的 1 号（值等价）

        esc()

        expect(h.confirm).not.toHaveBeenCalled()
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('真的改一个字符（小时 9 → 10）：Esc 仍先提醒', async () => {
        const {onClose} = await renderModal()

        fireEvent.click(cronToggle())
        fireEvent.change(screen.getByLabelText('每天 小时'), {target: {value: '10'}})
        h.confirm.mockResolvedValue(false)

        esc()

        await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))
        expect(onClose).not.toHaveBeenCalled()
    })
})
