// @vitest-environment jsdom
/**
 * 编辑弹窗 · 键盘与无障碍（ui-09）
 *
 * 判据（设计契约 H6 / §6 #15）：
 *  1. 每个**只有图标**的按钮都有可被读出的名字，且**不得只靠 `title`**——读屏软件把
 *     `title` 当兜底名，写作 `title="编辑"` 的按钮在部分场景（触摸 / 无 hover）根本不播报，
 *     故判据要求 `aria-label` 必填且它就是计算出的可访问名（而不是靠 `title` 兜底）。
 *  2. 表单每个标签与它的控件关联：用 `getByLabelText` 断言「标签点得到控件」，
 *     而不是断言 `htmlFor` 字符串。
 *  3. 错误提示落在 live region（`role="alert"`）上，且**同一时刻只有一处**——
 *     重复的 live region 会让读屏把同一件事念两遍（ui-05 已落地弹窗内那一处，本票只做复验）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import {computeAccessibleName} from 'dom-accessibility-api'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleFormData} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleResult} from '@shared/types/schedule'

const capEntry = (name: string, type: 'skill' | 'agent' | 'command', description: string) => ({
    id: name,
    name,
    description,
    type,
    source: type === 'command' ? 'user' : 'builtin',
    enabled: true,
    searchText: name.toLowerCase(),
})

const {capabilityQuery} = vi.hoisted(() => ({capabilityQuery: vi.fn()}))

beforeEach(() => {
    capabilityQuery.mockReset()
    capabilityQuery.mockImplementation(async () => [
        capEntry('code-reviewer', 'agent', '代码审查'),
        capEntry('brain-taxonomist', 'skill', '知识分类'),
    ])
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        // 列表给足：复核 B1 后「列表未就绪 / 空表」不再放行保存，本文件的用例要走到 onSave
        workspace: {
            getCurrent: vi.fn().mockResolvedValue(null),
            list: vi.fn().mockResolvedValue([{id: 'ws-1', name: '主工作区', path: 'E:/ws1'}]),
        },
        capability: {query: capabilityQuery, onCapabilityChanged: vi.fn(() => () => {})},
        openExternal: vi.fn(),
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
    // 票 11 起项目必填：本文件的用例考的是可访问名与 live region，故给一个非空值
    workspaceId: 'ws-1',
}

/** 渲染并等到能力列表就绪（CapabilityPicker 的那次跨进程往返 resolve 后） */
async function renderModal() {
    const onSave = vi.fn(async (): Promise<ScheduleResult<unknown>> => ({ok: true, data: null}))
    const onClose = vi.fn()
    render(<ScheduleEditModal initial={editInitial} onSave={onSave} onClose={onClose}/>)
    await waitFor(() => expect(screen.getByText('code-reviewer')).toBeTruthy(), {timeout: 3000})
    return {onSave, onClose}
}

/** 纯图标按钮 = 没有任何文本内容、只有 svg 的按钮 */
function iconOnlyButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('button')).filter(
        b => (b.textContent ?? '').trim() === '',
    ) as HTMLButtonElement[]
}

describe('每个只有图标的按钮都有可被读出的名字（H6）', () => {
    it('模态内纯图标按钮一律有 aria-label，且它就是计算出的可访问名（不靠 title 兜底）', async () => {
        await renderModal()

        const icons = iconOnlyButtons()
        // 至少要有「关闭」这一个纯图标按钮，否则本断言会退化成恒真
        expect(icons.length).toBeGreaterThan(0)

        const offenders = icons
            .map(el => ({
                name: el.getAttribute('data-name') ?? el.outerHTML.slice(0, 60),
                ariaLabel: el.getAttribute('aria-label'),
                accessible: computeAccessibleName(el).trim(),
            }))
            .filter(r => !r.ariaLabel || r.accessible !== r.ariaLabel)

        expect(offenders).toEqual([])
    })

    it('关闭按钮按可访问名「关闭」即可被找到（图标本身不承载名字）', async () => {
        await renderModal()

        const close = screen.getByRole('button', {name: '关闭'})
        expect(close.getAttribute('data-name')).toBe('schedule-edit-modal-button')
    })

    it('弹窗内每个按钮都有非空可访问名（含只有图标与含图标带文字的）', async () => {
        await renderModal()

        const unnamed = Array.from(document.querySelectorAll('button')).filter(
            b => computeAccessibleName(b).trim() === '',
        )
        expect(unnamed.map(b => b.getAttribute('data-name') ?? b.outerHTML.slice(0, 60))).toEqual([])
    })

    it('Cron 折叠按钮暴露展开状态（aria-expanded），点开后为 true', async () => {
        await renderModal()

        const toggle = screen.getByRole('button', {name: /什么时候执行|频率/})
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        fireEvent.click(toggle)
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })
})

describe('表单标签与控件关联（H6）', () => {
    it('任务名称 / 描述 / 任务提示词 的标签都点得到对应控件', async () => {
        await renderModal()

        expect(screen.getByLabelText('任务名称')).toBeTruthy()
        expect(screen.getByLabelText(/^描述/)).toBeTruthy()
        expect(screen.getByLabelText(/^任务提示词/)).toBeTruthy()
    })

    it('切到「本地脚本」后，脚本路径的标签仍点得到对应控件', async () => {
        await renderModal()

        fireEvent.click(screen.getByRole('button', {name: /本地脚本/}))
        expect(screen.getByLabelText('脚本路径')).toBeTruthy()
    })

    it('项目的可访问名与可见标签一致（自定义下拉同样有名字）', async () => {
        await renderModal()

        expect(screen.getByLabelText('项目')).toBeTruthy()
    })
})

describe('错误提示可被读屏软件播报（H6）', () => {
    it('写失败时 live region 恰好一处（role="alert"），内容为可读原因', async () => {
        const {onSave} = await renderModal()
        onSave.mockImplementation(async () => ({ok: false, error: 'db closed'} as const))

        fireEvent.click(screen.getByRole('button', {name: '保存'}))

        const alerts = await waitFor(() => {
            const found = document.querySelectorAll('[role="alert"]')
            expect(found.length).toBeGreaterThan(0)
            return found
        })
        expect(alerts.length).toBe(1)
        expect(alerts[0].textContent).toContain('编辑失败：db closed')
    })

    it('无错误时不留空的 live region（不制造噪音）', async () => {
        await renderModal()

        expect(document.querySelectorAll('[role="alert"]').length).toBe(0)
    })

    it('本地校验失败同样落在同一处 live region 上', async () => {
        const {onSave} = await renderModal()
        fireEvent.change(screen.getByLabelText('任务名称'), {target: {value: ''}})

        await act(async () => {
            fireEvent.click(screen.getByRole('button', {name: '保存'}))
        })

        const alerts = document.querySelectorAll('[role="alert"]')
        expect(alerts.length).toBe(1)
        expect(alerts[0].textContent).toBe('任务名称不能为空')
        expect(onSave).not.toHaveBeenCalled()
    })
})
