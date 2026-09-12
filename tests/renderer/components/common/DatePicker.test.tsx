// @vitest-environment jsdom
/**
 * DatePicker 组件测试
 *
 * 覆盖：
 * - 手输提交（合法 yyyy-mm-dd 且真实存在）→ onChange
 * - 手输非法（2026-02-30 / abc）→ 不提交、blur 还原为 value、Enter 不提交
 * - Enter 提交 / Esc 还原
 * - 打开弹层 → 点某日 → onChange 且弹层关闭
 * - 左右箭头切月、↑/↓ 切年
 * - 三级视图：日 → 月 → 年 → 选中年回月视图 → 选中月回日视图 → 选日生效
 * - 今天 / 清除 按钮
 * - 点击外部关闭
 * - 今日 aria-current="date"、选中日 aria-selected
 *
 * 确定性：vi.setSystemTime(2026-09-12) 固定"今天"（仅 fake Date，不 fake timer）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup} from '@testing-library/react'
import {useState} from 'react'
import DatePicker from '@/renderer/components/common/DatePicker'

/** 固定"今天"为 2026-09-12（周六） */
const TODAY = new Date(2026, 8, 12)

beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']})
    vi.setSystemTime(TODAY)
    cleanup()
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

/** 受控包装：真实回写 value，模拟调用点的受控用法 */
function Controlled({initial = '', onChange}: {initial?: string; onChange?: (n: string) => void}) {
    const [v, setV] = useState(initial)
    return (
        <DatePicker
            value={v}
            ariaLabel="测试日期"
            onChange={(n) => {
                setV(n)
                onChange?.(n)
            }}
        />
    )
}

const input = () => screen.getByLabelText('测试日期') as HTMLInputElement
const monthTitle = () => screen.getByTestId('datepicker-month-title')
const openPanel = () => fireEvent.mouseDown(input())

describe('DatePicker 手输', () => {
    it('① 手输合法日期 → 按 Enter 提交 onChange', () => {
        const onChange = vi.fn()
        render(<Controlled onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: '2026-09-20'}})
        fireEvent.keyDown(input(), {key: 'Enter'})
        expect(onChange).toHaveBeenCalledWith('2026-09-20')
    })

    it('② 手输非法（2026-02-30）→ Enter 不提交，blur 还原为 value', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-01-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: '2026-02-30'}})
        fireEvent.keyDown(input(), {key: 'Enter'})
        expect(onChange).not.toHaveBeenCalled()
        // 保留用户输入直到 blur（不静默清空）
        expect(input().value).toBe('2026-02-30')
        fireEvent.blur(input())
        expect(input().value).toBe('2026-01-05')
    })

    it('② 手输非法（abc）→ 不提交、blur 还原', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-01-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: 'abc'}})
        expect(onChange).not.toHaveBeenCalled()
        fireEvent.blur(input())
        expect(input().value).toBe('2026-01-05')
    })

    it('④ 删空后 blur 等价于清除（与原生 date input 的清空语义对齐）', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-01-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: ''}})
        fireEvent.blur(input())
        expect(onChange).toHaveBeenCalledWith('')
        expect(input().value).toBe('')
    })

    it('④ 删空后 Enter 同样提交清除；原本为空时不产生重复回调', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-01-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: '   '}})
        fireEvent.keyDown(input(), {key: 'Enter'})
        expect(onChange).toHaveBeenCalledWith('')

        const onChange2 = vi.fn()
        cleanup()
        render(<Controlled initial="" onChange={onChange2}/>)
        fireEvent.keyDown(input(), {key: 'Enter'})
        fireEvent.blur(input())
        expect(onChange2).not.toHaveBeenCalled()
    })

    it('③ Esc 还原为 value，不提交', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-01-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: '2026-09-20'}})
        fireEvent.keyDown(input(), {key: 'Escape'})
        expect(input().value).toBe('2026-01-05')
        expect(onChange).not.toHaveBeenCalled()
    })

    it('value 外部变化时同步 draft', () => {
        const {rerender} = render(<DatePicker value="2026-01-05" ariaLabel="测试日期" onChange={() => {}}/>)
        expect(input().value).toBe('2026-01-05')
        rerender(<DatePicker value="2026-03-09" ariaLabel="测试日期" onChange={() => {}}/>)
        expect(input().value).toBe('2026-03-09')
    })
})

describe('DatePicker 手输 blur 提交（F2：与原生 date input 失焦即提交对齐）', () => {
    it('① 手输合法日期后不按 Enter、直接 blur → onChange 收到该值', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-09-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: '2026-09-20'}})
        fireEvent.blur(input())
        expect(onChange).toHaveBeenCalledWith('2026-09-20')
        expect(input().value).toBe('2026-09-20')
    })

    it('② 手输合法值但与原 value 相同 → blur 不产生回调', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-09-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: '2026-09-05'}})
        fireEvent.blur(input())
        expect(onChange).not.toHaveBeenCalled()
    })
})

/** 受控包装：忽略空值（照 UsageWindow 语义：空值不提交，起始/结束恒有值） */
function IgnoreEmptyControlled({initial}: {initial: string}) {
    const [v, setV] = useState(initial)
    return (
        <DatePicker
            value={v}
            ariaLabel="测试日期"
            onChange={(n) => {
                if (n) setV(n)
            }}
        />
    )
}

/** 受控包装：总是把提交改写成另一个合法值 */
function RewriteControlled({initial}: {initial: string}) {
    const [v, setV] = useState(initial)
    return <DatePicker value={v} ariaLabel="测试日期" onChange={() => setV('2026-03-01')}/>
}

describe('DatePicker 提交未被采纳时回滚显示（F3）', () => {
    it('① 父组件忽略空值：删空 + blur 后输入框显示回旧值（不是空）', () => {
        render(<IgnoreEmptyControlled initial="2026-01-05"/>)
        fireEvent.change(input(), {target: {value: ''}})
        fireEvent.blur(input())
        expect(input().value).toBe('2026-01-05')
    })

    it('② 正常受控父组件（采纳值）下 draft 正常更新（回归）', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-01-05" onChange={onChange}/>)
        fireEvent.change(input(), {target: {value: '2026-08-20'}})
        fireEvent.blur(input())
        expect(onChange).toHaveBeenCalledWith('2026-08-20')
        expect(input().value).toBe('2026-08-20')
    })

    it('③ 提交被父组件改写成别的合法值时，显示跟父组件走', () => {
        render(<RewriteControlled initial="2026-01-05"/>)
        fireEvent.change(input(), {target: {value: '2026-09-20'}})
        fireEvent.blur(input())
        expect(input().value).toBe('2026-03-01')
    })
})

describe('DatePicker 弹层与日历', () => {
    it('④ 打开弹层 → 点某日 → onChange 且弹层关闭', () => {
        const onChange = vi.fn()
        render(<Controlled onChange={onChange}/>)
        openPanel()
       
        expect(screen.getByRole('dialog', {name: '测试日期日期选择'})).toBeTruthy()
        fireEvent.click(screen.getByRole('button', {name: '2026年09月20日'}))
        expect(onChange).toHaveBeenCalledWith('2026-09-20')
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('⑤ 左右箭头切月（月头文案变化）', () => {
        render(<Controlled initial="2026-09-12"/>)
        openPanel()
        expect(monthTitle().textContent).toBe('2026年09月')
        fireEvent.click(screen.getByRole('button', {name: '下一个月'}))
        expect(monthTitle().textContent).toBe('2026年10月')
        fireEvent.click(screen.getByRole('button', {name: '上一个月'}))
        fireEvent.click(screen.getByRole('button', {name: '上一个月'}))
        expect(monthTitle().textContent).toBe('2026年08月')
    })

    it('⑥ ↑/↓ 图标切年', () => {
        render(<Controlled initial="2026-09-12"/>)
        openPanel()
        fireEvent.click(screen.getByRole('button', {name: '下一年'}))
        expect(monthTitle().textContent).toBe('2027年09月')
        fireEvent.click(screen.getByRole('button', {name: '上一年'}))
        expect(monthTitle().textContent).toBe('2026年09月')
    })

    it('⑦ 三级视图：日 → 月 → 年 → 回月 → 回日 → 选日生效', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-09-12" onChange={onChange}/>)
        openPanel()
        // 点月头进入月份网格
        fireEvent.click(monthTitle())
        expect(screen.getByTestId('datepicker-year-title').textContent).toBe('2026年')
        // 点年标题进入年份网格
        fireEvent.click(screen.getByTestId('datepicker-year-title'))
        expect(screen.getByTestId('datepicker-years-range').textContent).toContain('2016年')
        // 选中年份 → 回到月份网格
        fireEvent.click(screen.getByRole('button', {name: '2024年'}))
        expect(screen.getByTestId('datepicker-year-title').textContent).toBe('2024年')
        expect(screen.getByRole('button', {name: '2024年03月'})).toBeTruthy()
        // 选中月份 → 回到日视图
        fireEvent.click(screen.getByRole('button', {name: '2024年03月'}))
        expect(screen.getByTestId('datepicker-month-title').textContent).toBe('2024年03月')
        // 选中某日 → onChange 生效
        fireEvent.click(screen.getByRole('button', {name: '2024年03月15日'}))
        expect(onChange).toHaveBeenCalledWith('2024-03-15')
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('⑦b 年份网格可前后翻页', () => {
        render(<Controlled initial="2026-09-12"/>)
        openPanel()
        fireEvent.click(monthTitle())
        fireEvent.click(screen.getByTestId('datepicker-year-title'))
        expect(screen.getByRole('button', {name: '2016年'})).toBeTruthy()
        fireEvent.click(screen.getByRole('button', {name: '下一页'}))
        expect(screen.getByRole('button', {name: '2028年'})).toBeTruthy()
    })

    it('⑦c Esc 逐级返回：年 → 月 → 日 → 关闭', () => {
        render(<Controlled initial="2026-09-12"/>)
        openPanel()
        fireEvent.click(monthTitle()) // 月视图
        fireEvent.click(screen.getByTestId('datepicker-year-title')) // 年视图
        fireEvent.keyDown(document, {key: 'Escape'})
        expect(screen.getByTestId('datepicker-year-title').textContent).toBe('2026年') // 回到月视图
        fireEvent.keyDown(document, {key: 'Escape'})
        expect(screen.getByTestId('datepicker-month-title')).toBeTruthy() // 回到日视图
        fireEvent.keyDown(document, {key: 'Escape'})
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('⑧ 今天 / 清除 按钮', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-09-01" onChange={onChange}/>)
        openPanel()
        fireEvent.click(screen.getByRole('button', {name: '今天'}))
        expect(onChange).toHaveBeenCalledWith('2026-09-12')
        expect(screen.queryByRole('dialog')).toBeNull()

        openPanel()
        fireEvent.click(screen.getByRole('button', {name: '清除'}))
        expect(onChange).toHaveBeenCalledWith('')
    })

    it('⑨ 点击组件外部关闭', () => {
        render(<Controlled initial="2026-09-01"/>)
        openPanel()
        expect(screen.getByRole('dialog')).toBeTruthy()
        fireEvent.mouseDown(document.body)
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('⑩ 今日 aria-current="date"，选中日 aria-selected="true"', () => {
        render(<Controlled initial="2026-09-12"/>)
        openPanel()
        const todayCell = screen.getByRole('button', {name: '2026年09月12日'})
        expect(todayCell.getAttribute('aria-current')).toBe('date')
        expect(todayCell.getAttribute('aria-selected')).toBe('true')
    })

    it('⑪ 相邻月置灰日期可点：点了跳月并选中', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-09-12" onChange={onChange}/>)
        openPanel()
        fireEvent.click(screen.getByRole('button', {name: '2026年10月01日'}))
        expect(onChange).toHaveBeenCalledWith('2026-10-01')
    })
})

/** 受控包装（带 min/max 约束） */
function ControlledRange({initial = '', min, max, onChange}: {
    initial?: string
    min?: string
    max?: string
    onChange?: (n: string) => void
}) {
    const [v, setV] = useState(initial)
    return (
        <DatePicker
            value={v}
            ariaLabel="测试日期"
            min={min}
            max={max}
            onChange={(n) => {
                setV(n)
                onChange?.(n)
            }}
        />
    )
}

describe('DatePicker min/max 约束', () => {
    it('① 超出 max 的日期 disabled 且点击不触发 onChange', () => {
        const onChange = vi.fn()
        render(<ControlledRange initial="2026-09-05" max="2026-09-10" onChange={onChange}/>)
        openPanel()
        // 2026-09-11 / 09-12（今天）超出 max=09-10 → disabled
        const over = screen.getByRole('button', {name: '2026年09月12日'}) as HTMLButtonElement
        expect(over.disabled).toBe(true)
        expect((screen.getByRole('button', {name: '2026年09月11日'}) as HTMLButtonElement).disabled).toBe(true)
        fireEvent.click(over)
        expect(onChange).not.toHaveBeenCalled()
        // 边界内（=max）可选
        const atMax = screen.getByRole('button', {name: '2026年09月10日'}) as HTMLButtonElement
        expect(atMax.disabled).toBe(false)
        fireEvent.click(atMax)
        expect(onChange).toHaveBeenCalledWith('2026-09-10')
    })

    it('② 早于 min 的日期 disabled 且点击无效；边界 =min 可选', () => {
        const onChange = vi.fn()
        render(<ControlledRange initial="2026-09-05" min="2026-09-03" onChange={onChange}/>)
        openPanel()
        const before = screen.getByRole('button', {name: '2026年09月02日'}) as HTMLButtonElement
        expect(before.disabled).toBe(true)
        fireEvent.click(before)
        expect(onChange).not.toHaveBeenCalled()
        // 相邻月更早的日期同样 disabled（08-31）
        const prevMonth = screen.getByRole('button', {name: '2026年08月31日'}) as HTMLButtonElement
        expect(prevMonth.disabled).toBe(true)
        // 边界 =min 可选
        const atMin = screen.getByRole('button', {name: '2026年09月03日'}) as HTMLButtonElement
        expect(atMin.disabled).toBe(false)
        fireEvent.click(atMin)
        expect(onChange).toHaveBeenCalledWith('2026-09-03')
    })

    it('③ 手输超范围不提交、blur 还原为 value（与非法日期同等处理）', () => {
        const onChange = vi.fn()
        render(<ControlledRange initial="2026-09-05" min="2026-09-01" max="2026-09-10" onChange={onChange}/>)
        // 晚于 max
        fireEvent.change(input(), {target: {value: '2026-10-01'}})
        fireEvent.keyDown(input(), {key: 'Enter'})
        expect(onChange).not.toHaveBeenCalled()
        expect(input().value).toBe('2026-10-01') // 保留到 blur
        fireEvent.blur(input())
        expect(input().value).toBe('2026-09-05')
        // 早于 min
        fireEvent.change(input(), {target: {value: '2026-08-20'}})
        fireEvent.keyDown(input(), {key: 'Enter'})
        expect(onChange).not.toHaveBeenCalled()
        fireEvent.blur(input())
        expect(input().value).toBe('2026-09-05')
        // 范围内正常提交
        fireEvent.change(input(), {target: {value: '2026-09-08'}})
        fireEvent.keyDown(input(), {key: 'Enter'})
        expect(onChange).toHaveBeenCalledWith('2026-09-08')
    })

    it('④ 不传 min/max 时全部可选（回归）', () => {
        const onChange = vi.fn()
        render(<Controlled initial="2026-09-12" onChange={onChange}/>)
        openPanel()
        // 全部日格均未 disabled
        expect((screen.getByRole('button', {name: '2026年09月01日'}) as HTMLButtonElement).disabled).toBe(false)
        expect((screen.getByRole('button', {name: '2026年10月01日'}) as HTMLButtonElement).disabled).toBe(false)
        // 远未来（2027-01-15）同样可选
        fireEvent.click(monthTitle())
        fireEvent.click(screen.getByTestId('datepicker-year-title'))
        fireEvent.click(screen.getByRole('button', {name: '2027年'}))
        fireEvent.click(screen.getByRole('button', {name: '2027年01月'}))
        const far = screen.getByRole('button', {name: '2027年01月15日'}) as HTMLButtonElement
        expect(far.disabled).toBe(false)
        fireEvent.click(far)
        expect(onChange).toHaveBeenCalledWith('2027-01-15')
    })

    it('⑤ 快速切月/切年不被锁死（可浏览），仅不可选日 disabled', () => {
        render(<ControlledRange initial="2026-09-05" max="2026-09-10"/>)
        openPanel()
        // 下一个月：标题切换成功
        fireEvent.click(screen.getByRole('button', {name: '下一个月'}))
        expect(monthTitle().textContent).toBe('2026年10月')
        // 10 月全部日期超出 max → 均 disabled，但导航未被锁
        expect((screen.getByRole('button', {name: '2026年10月15日'}) as HTMLButtonElement).disabled).toBe(true)
        fireEvent.click(screen.getByRole('button', {name: '上一个月'}))
        expect(monthTitle().textContent).toBe('2026年09月')
        // 切年同样可浏览
        fireEvent.click(screen.getByRole('button', {name: '下一年'}))
        expect(monthTitle().textContent).toBe('2027年09月')
    })

    it('⑥ 今天超出范围时"今天"按钮禁用；范围内时可用', () => {
        // max=2026-09-10 < 今天(09-12) → 禁用
        render(<ControlledRange initial="2026-09-05" max="2026-09-10"/>)
        openPanel()
        expect((screen.getByRole('button', {name: '今天'}) as HTMLButtonElement).disabled).toBe(true)
        cleanup()
        // min 未超（今天在范围内）→ 可用
        render(<ControlledRange initial="2026-09-05" min="2026-09-01"/>)
        openPanel()
        expect((screen.getByRole('button', {name: '今天'}) as HTMLButtonElement).disabled).toBe(false)
    })
})
