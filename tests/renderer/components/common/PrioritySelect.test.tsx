// @vitest-environment jsdom
/**
 * PrioritySelect 组件测试
 *
 * 覆盖：缺省渲染"普通"、下拉菜单展开与选项、onChange 与菜单关闭、
 * stopPropagation（不触发外层行 onClick）、disabled 不响应、点击外部关闭。
 *
 * 无 portal / 无第三方依赖，全部使用 testing-library 朴素方式。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup} from '@testing-library/react'
import {useState} from 'react'
import {PrioritySelect} from '@/renderer/components/common/PrioritySelect'
import type {MemoPriority} from '@/shared/types/memo'

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

/** 受控包装：真实记录 onChange 后的 value，模拟父组件受控用法 */
function Controlled(props: {initial?: MemoPriority; onChange?: (p: MemoPriority) => void; disabled?: boolean}) {
    const [v, setV] = useState<MemoPriority | undefined>(props.initial)
    return (
        <PrioritySelect
            value={v}
            disabled={props.disabled}
            onChange={(p) => {
                setV(p)
                props.onChange?.(p)
            }}
        />
    )
}

describe('PrioritySelect', () => {
    it('缺省 value（undefined）显示"普通"', () => {
        render(<PrioritySelect onChange={vi.fn()}/>)
        expect(screen.getByTestId('priority-trigger').textContent).toContain('普通')
    })

    it('value=urgent 时触发按钮显示"紧急"', () => {
        render(<PrioritySelect value="urgent" onChange={vi.fn()}/>)
        expect(screen.getByTestId('priority-trigger').textContent).toContain('紧急')
    })

    it('点击打开下拉菜单，四个选项及颜色圆点可见', () => {
        render(<PrioritySelect onChange={vi.fn()}/>)
        expect(screen.queryByTestId('priority-menu')).toBeNull()

        fireEvent.click(screen.getByTestId('priority-trigger'))
        const menu = screen.getByTestId('priority-menu')
        for (const [val, label] of [['urgent', '紧急'], ['high', '高'], ['normal', '普通'], ['low', '低']] as const) {
            const opt = screen.getByTestId(`priority-option-${val}`)
            expect(opt.textContent).toContain(label)
            // 颜色圆点（span，有 background 内联样式）
            const dot = opt.querySelector('span')
            expect(dot?.style.background).toBeTruthy()
        }
        expect(menu).toBeTruthy()
    })

    it('再次点击触发按钮切换（关闭）菜单', () => {
        render(<PrioritySelect onChange={vi.fn()}/>)
        fireEvent.click(screen.getByTestId('priority-trigger'))
        expect(screen.getByTestId('priority-menu')).toBeTruthy()
        fireEvent.click(screen.getByTestId('priority-trigger'))
        expect(screen.queryByTestId('priority-menu')).toBeNull()
    })

    it('选择某项触发 onChange 且值正确，菜单关闭', () => {
        const onChange = vi.fn()
        render(<Controlled onChange={onChange}/>)

        fireEvent.click(screen.getByTestId('priority-trigger'))
        fireEvent.click(screen.getByTestId('priority-option-high'))
        expect(onChange).toHaveBeenCalledWith('high')
        // 受控更新后触发按钮显示"高"，菜单已关闭
        expect(screen.getByTestId('priority-trigger').textContent).toContain('高')
        expect(screen.queryByTestId('priority-menu')).toBeNull()
    })

    it('点击组件内部不冒泡：外层行 onClick 不被触发', () => {
        const rowClick = vi.fn()
        render(
            <div data-testid="row" onClick={rowClick}>
                <PrioritySelect onChange={vi.fn()}/>
            </div>,
        )

        // 点击触发按钮
        fireEvent.click(screen.getByTestId('priority-trigger'))
        expect(rowClick).not.toHaveBeenCalled()

        // 菜单已开，点击菜单选项
        fireEvent.click(screen.getByTestId('priority-option-low'))
        expect(rowClick).not.toHaveBeenCalled()
        expect(screen.queryByTestId('priority-menu')).toBeNull()
    })

    it('disabled 时不响应交互（按钮 disabled + 容器 pointer-events-none）', () => {
        const onChange = vi.fn()
        render(<PrioritySelect onChange={onChange} disabled={true}/>)

        const root = screen.getByTestId('priority-select')
        expect(root.className).toContain('pointer-events-none')
        expect(root.className).toContain('opacity-50')

        const trigger = screen.getByTestId('priority-trigger') as HTMLButtonElement
        expect(trigger.disabled).toBe(true)
        // jsdom 会拦截 disabled button 的 click，双保险断言
        fireEvent.click(trigger)
        expect(screen.queryByTestId('priority-menu')).toBeNull()
        expect(onChange).not.toHaveBeenCalled()
    })

    it('点击外部区域关闭菜单', () => {
        render(<PrioritySelect onChange={vi.fn()}/>)
        fireEvent.click(screen.getByTestId('priority-trigger'))
        expect(screen.getByTestId('priority-menu')).toBeTruthy()

        // 组件外点击（document mousedown 路径）
        fireEvent.mouseDown(document.body)
        expect(screen.queryByTestId('priority-menu')).toBeNull()
    })

    it('菜单内部点击（非选项区域）不关闭', () => {
        render(<PrioritySelect onChange={vi.fn()}/>)
        fireEvent.click(screen.getByTestId('priority-trigger'))
        fireEvent.mouseDown(screen.getByTestId('priority-menu'))
        expect(screen.getByTestId('priority-menu')).toBeTruthy()
    })
})
