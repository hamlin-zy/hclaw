// @vitest-environment jsdom
/**
 * ScheduleEditModal —— 时间配置器重做（ui-08）
 *
 * 断言用户能看到 / 点了会发生什么：
 *  - 折叠摘要是人话，且**不含**原始表达式；
 *  - 原始表达式只在高级模式（展开后）出现；
 *  - 无法归类的表达式落高级模式并**明确告知**；
 *  - 读出再写回等价（保存时 cronExpression 不被改写）；
 *  - 每周直接点星期几会写进表达式。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'

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

/**
 * 工作区列表桩：票 11 复核整改（B1）后，「列表未就绪」**不再放行**保存
 * （手里没有列表就无从校验工作目录，放行等于把没校验过的 id 落库）。
 * 本文件考的是表达式的往返保真，故把列表给足，让保存能走到 onSave。
 */
const WORKSPACES = [{id: 'ws-1', name: '主工作区', path: 'E:/ws1'}]

beforeEach(() => {
    capabilityQuery.mockReset()
    capabilityQuery.mockImplementation(async () => [
        capEntry('code-reviewer', 'agent', '代码审查'),
        capEntry('brain-taxonomist', 'skill', '知识分类'),
    ])
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        workspace: {getCurrent: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue(WORKSPACES)},
        capability: {query: capabilityQuery, onCapabilityChanged: vi.fn(() => () => {})},
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

/**
 * 渲染并选中一个能力，使保存可用。
 * `workspaceId` 兜一个非空值：票 11 起工作目录必填，否则保存会被拦在弹窗内、
 * 本文件的 cron 用例就再也到不了 onSave（那些用例考的是表达式往返，不是工作目录）。
 */
async function renderWithCapability(initial: any) {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<ScheduleEditModal initial={{workspaceId: 'ws-1', ...initial}} onSave={onSave} onClose={onClose}/>)
    await waitFor(() => expect(screen.getByText('code-reviewer')).toBeTruthy(), {timeout: 3000})
    fireEvent.click(screen.getByText('code-reviewer'))
    return {onSave, onClose}
}

describe('折叠摘要 —— 人话、不与原始表达式混排', () => {
    it('每周摘要出「每工作日 08:30」，且不含原始表达式', () => {
        render(<ScheduleEditModal initial={{cronExpression: '30 8 * * 1-5'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        expect(screen.getByText('每工作日 08:30')).toBeTruthy()
        expect(screen.queryByText(/30 8 \* \* 1-5/)).toBeNull()
    })

    it('写法写不回的表达式：摘要只说「高级」，原文不外露，且给出可见告知', () => {
        render(<ScheduleEditModal initial={{cronExpression: '0 9 1,15 * *'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        expect(screen.getByText('自定义（高级表达式）')).toBeTruthy()
        // 未展开时原始表达式不出现在页面上
        expect(screen.queryByDisplayValue('0 9 1,15 * *')).toBeNull()
        // 明确告知——且措辞不说错话（I-3）：这条表达式语义能懂，只是写法写不回，
        // 所以不能说「无法套用四种说法」。
        expect(screen.getByText(/没能原样对应/)).toBeTruthy()
        expect(screen.queryByText(/无法套用/)).toBeNull()
    })

    it('根本不是五段格式的表达式：措辞与「写法写不回」可区分', () => {
        render(<ScheduleEditModal initial={{cronExpression: 'not a cron'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        expect(screen.getByText(/不是标准的分 时 日 月 周 五段格式/)).toBeTruthy()
        expect(screen.queryByText(/没能原样对应/)).toBeNull()
    })

    it('可归类的表达式不出现告知，`0 9 * * 7` / `0 9 * * MON` 也在其列', () => {
        for (const expr of ['0 9 * * *', '0 9 * * 7', '0 9 * * MON']) {
            const {unmount} = render(<ScheduleEditModal initial={{cronExpression: expr}} onSave={vi.fn()} onClose={vi.fn()}/>)
            expect(screen.queryByText(/没能原样对应/), expr).toBeNull()
            expect(screen.queryByText(/五段格式/), expr).toBeNull()
            unmount()
        }
    })

    it('`0 9 * * 7` 落到「每周」并选中周日（不是「高级」）', () => {
        render(<ScheduleEditModal initial={{cronExpression: '0 9 * * 7'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        fireEvent.click(screen.getByText(/频率:/))
        expect(screen.getByLabelText('周日').getAttribute('aria-pressed')).toBe('true')
    })
})

describe('高级模式 —— 原始表达式只在此出现', () => {
    it('展开后，无法归类的表达式原样出现在高级输入框', () => {
        render(<ScheduleEditModal initial={{cronExpression: '0 9 1,15 * *'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        fireEvent.click(screen.getByText(/频率:/))
        expect(screen.getByDisplayValue('0 9 1,15 * *')).toBeTruthy()
    })
})

describe('往返保真 —— 读出再写回不改写', () => {
    it('「0 9 1,15 * *」保存后仍是「0 9 1,15 * *」', async () => {
        const {onSave} = await renderWithCapability({cronExpression: '0 9 1,15 * *'})
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '报表'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe('0 9 1,15 * *')
    })

    it('正常可归类的「30 8 * * 1-5」保存后不被改写', async () => {
        const {onSave} = await renderWithCapability({cronExpression: '30 8 * * 1-5'})
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '早报'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe('30 8 * * 1-5')
    })
})

describe('每周 —— 直接点星期几', () => {
    it('在「0 9 * * 1」上点周三 → 保存为「0 9 * * 1,3」', async () => {
        const {onSave} = await renderWithCapability({cronExpression: '0 9 * * 1'})
        fireEvent.click(screen.getByText(/频率:/))
        // 周三：WEEKDAY_LABELS 下标 3
        fireEvent.click(screen.getByLabelText('周三'))
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '周三任务'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe('0 9 * * 1,3')
    })
})

describe('数字字段 —— 键盘输入可改变值', () => {
    it('每天的分钟改成 45 会写进保存结果', async () => {
        const {onSave} = await renderWithCapability({cronExpression: '0 9 * * *'})
        fireEvent.click(screen.getByText(/频率:/))
        const field = screen.getByLabelText('每天 分钟') as HTMLInputElement
        expect(field.type).toBe('number')
        fireEvent.change(field, {target: {value: '45'}})
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '定时'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe('45 9 * * *')
    })
})

/** I-1 的告知元素（内容含嵌套元素，故按 data-name 取容器再断言文本） */
const changedNotice = () => document.querySelector('[data-name="schedule-edit-modal-cron-changed-notice"]')
const unrecognizedNotice = () => document.querySelector('[data-name="schedule-edit-modal-cron-unrecognized-notice"]')

describe('I-1 —— 点一下「每天」不再静默丢掉原频率', () => {
    it('从「高级」切到「每天」：时/分从原表达式派生，且显式告知频率已更改', async () => {
        const {onSave} = await renderWithCapability({cronExpression: '30 14 1,15 * *'})
        fireEvent.click(screen.getByText(/频率:/))
        // 切之前：落「高级」，原文可见（未被归一化改写）
        expect(unrecognizedNotice()).toBeTruthy()

        fireEvent.click(screen.getByText('每天'))

        // 派生：14:30（原表达式的时/分），而不是 makeDefaultConfig 凭空给的 9:00
        expect((screen.getByLabelText('每天 小时') as HTMLInputElement).value).toBe('14')
        expect((screen.getByLabelText('每天 分钟') as HTMLInputElement).value).toBe('30')
        // 告知不中断：原「无法归类」的告警换成了「频率已更改（原：…）」
        expect(unrecognizedNotice()).toBeNull()
        expect(changedNotice()?.textContent).toContain('频率已更改')
        expect(changedNotice()?.textContent).toContain('30 14 1,15 * *')

        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '报表'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe('30 14 * * *')
    })

    it('点回「高级」：原表达式仍在输入框里，告知随之撤下', async () => {
        render(<ScheduleEditModal initial={{cronExpression: '30 14 1,15 * *'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        fireEvent.click(screen.getByText(/频率:/))
        fireEvent.click(screen.getByText('每天'))
        expect(changedNotice()).toBeTruthy()
        fireEvent.click(screen.getByText('高级'))
        expect(changedNotice()).toBeNull()
        expect(screen.getByDisplayValue('30 14 1,15 * *')).toBeTruthy()
    })

    it('从「高级」切到「每周」：星期集从原表达式派生', async () => {
        // 用真正落「高级」的表达式（日+周并存），否则「切换」根本没发生，断言会假绿
        render(<ScheduleEditModal initial={{cronExpression: '0 9 1 * 1,3'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        fireEvent.click(screen.getByText(/频率:/))
        expect(unrecognizedNotice()).toBeTruthy()
        fireEvent.click(screen.getByText('每周'))
        expect(screen.getByLabelText('周一').getAttribute('aria-pressed')).toBe('true')
        expect(screen.getByLabelText('周三').getAttribute('aria-pressed')).toBe('true')
        expect(screen.getByLabelText('周二').getAttribute('aria-pressed')).toBe('false')
        expect(screen.getByLabelText('周四').getAttribute('aria-pressed')).toBe('false')
    })
})

describe('I-2 —— 每月直接点几号（日期网格）', () => {
    it('每月渲染 1..31 的日期网格，点「15 号」会写进保存结果', async () => {
        const {onSave} = await renderWithCapability({cronExpression: '0 9 1 * *'})
        fireEvent.click(screen.getByText(/频率:/))
        const cells = Array.from(screen.getByRole('group', {name: '每月几号'}).querySelectorAll('button'))
        expect(cells.length).toBe(31)
        expect(cells.length).toBeGreaterThanOrEqual(28)
        expect(cells[0].textContent).toBe('1')
        expect(cells[30].textContent).toBe('31')

        fireEvent.click(screen.getByRole('button', {name: '15 号'}))
        expect(screen.getByRole('button', {name: '15 号'}).getAttribute('aria-pressed')).toBe('true')
        expect(screen.getByRole('button', {name: '1 号'}).getAttribute('aria-pressed')).toBe('false')

        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '月报'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe('0 9 15 * *')
    })

    it('日期网格键盘可达：每个格子都是可 Tab 聚焦的原生 button，聚焦后 Enter/Space 即激活', () => {
        render(<ScheduleEditModal initial={{cronExpression: '0 9 1 * *'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        fireEvent.click(screen.getByText(/频率:/))
        const cells = Array.from(screen.getByRole('group', {name: '每月几号'}).querySelectorAll('button')) as HTMLButtonElement[]
        for (const c of cells) {
            expect(c.tagName).toBe('BUTTON')  // 原生 button ⇒ 天然可聚焦、Enter/Space 可激活
            expect(c.tabIndex).toBe(0)        // 未被排除出 Tab 序
            expect(c.getAttribute('data-name')).toBeTruthy()
        }
        const d = screen.getByRole('button', {name: '9 号'})
        d.focus()
        expect(document.activeElement).toBe(d)
        fireEvent.click(d)  // 原生 button 上 Enter/Space 触发的就是 click
        expect(d.getAttribute('aria-pressed')).toBe('true')
    })
})

describe('II-5 —— 高级表达式清空后不静默写成别的频率', () => {
    it('清空高级输入框后保存：拒存并给出校验错误，不写回 `0 9 * * *`', async () => {
        const {onSave} = await renderWithCapability({cronExpression: '0 9 1,15 * *'})
        fireEvent.click(screen.getByText(/频率:/))
        fireEvent.change(screen.getByDisplayValue('0 9 1,15 * *'), {target: {value: ''}})
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '空表达式'}})
        fireEvent.click(screen.getByText('保存'))
        expect(onSave).not.toHaveBeenCalled()
        expect(screen.getByText('请填写 cron 表达式')).toBeTruthy()
    })

    it('已存在的任务是空表达式（initial.cronExpression 为空串）时同样拒存，不被默认的「每天 09:00」顶替', async () => {
        const {onSave} = await renderWithCapability({id: 'sched-empty', cronExpression: ''})
        // 空串走 cronToConfig('') → 高级模式，而不是 makeDefaultConfig 的「每天 09:00」
        expect(screen.getByText('自定义（高级表达式）')).toBeTruthy()
        expect(screen.queryByText('每天 09:00')).toBeNull()
        expect(unrecognizedNotice()).toBeTruthy()
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '空表达式'}})
        fireEvent.click(screen.getByText('保存'))
        expect(onSave).not.toHaveBeenCalled()
        expect(screen.getByText('请填写 cron 表达式')).toBeTruthy()
    })

    it('新建任务（initial 无 cronExpression）仍默认「每天 09:00」', async () => {
        const {onSave} = await renderWithCapability(undefined)
        expect(screen.getByText('每天 09:00')).toBeTruthy()
        expect(unrecognizedNotice()).toBeNull()
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '新建任务'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe('0 9 * * *')
    })
})

describe('回归 —— 非法周区间 `7-k` 不被判成可归类、不被静默改写', () => {
    it.each(['0 9 * * 7-1', '0 9 * * 7-6'])('%s：给出告知 + 摘要只说「高级」，不冒充四种说法', (expr) => {
        render(<ScheduleEditModal initial={{cronExpression: expr}} onSave={vi.fn()} onClose={vi.fn()}/>)
        expect(screen.getByText('自定义（高级表达式）')).toBeTruthy()
        expect(unrecognizedNotice()).toBeTruthy()
        expect(screen.getByText(/没能原样对应/)).toBeTruthy()
    })

    it.each(['0 9 * * 7-1', '0 9 * * 7-6'])('%s：保存后逐字节不变（不变成 `0-1` / `0-6`）', async (expr) => {
        const {onSave} = await renderWithCapability({cronExpression: expr})
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '非法区间'}})
        fireEvent.click(screen.getByText('保存'))
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].cronExpression).toBe(expr)
    })

    it('展开高级后原文仍在输入框里（未被归一化污染）', () => {
        render(<ScheduleEditModal initial={{cronExpression: '0 9 * * 7-1'}} onSave={vi.fn()} onClose={vi.fn()}/>)
        fireEvent.click(screen.getByText(/频率:/))
        expect(screen.getByDisplayValue('0 9 * * 7-1')).toBeTruthy()
        expect(screen.queryByDisplayValue('0 9 * * 0-1')).toBeNull()
    })
})
