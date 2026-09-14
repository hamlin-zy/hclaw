// @vitest-environment jsdom
/**
 * PluginGroupCard（共享插件分组卡片）折叠语义、批量按钮冒泡、DOM 合法性、a11y 与 data-name 回归护栏。
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {useState} from 'react'
import {render, fireEvent, cleanup} from '@testing-library/react'
import PluginGroupCard from '../../../../src/renderer/components/common/PluginGroupCard'

afterEach(() => cleanup())

/** 受控折叠测试壳：把折叠态提升到外部 state，模拟真实调用方。 */
function Harness({
    initialCollapsed = true,
    allEnabled = false,
    onToggleBatch,
    titleExtra,
    headerDataName = 'test-plugin-group-header',
    batchDataName = 'test-batch-toggle-button',
}: {
    initialCollapsed?: boolean
    allEnabled?: boolean
    onToggleBatch?: () => void
    titleExtra?: React.ReactNode
    headerDataName?: string
    batchDataName?: string
}) {
    const [collapsed, setCollapsed] = useState(initialCollapsed)
    // 批量按钮与 batchDataName 是「联动必填」：传批量回调才传 data-name（契约由类型强制）
    const common = {
        title: 'demo',
        titleExtra,
        countLabel: '2 个技能',
        collapsed,
        onToggleCollapse: () => setCollapsed(c => !c),
        allEnabled,
        headerDataName,
    }
    const body = <div data-testid="child">子项</div>
    return onToggleBatch
        ? <PluginGroupCard {...common} onToggleBatch={onToggleBatch} batchDataName={batchDataName}>{body}</PluginGroupCard>
        : <PluginGroupCard {...common}>{body}</PluginGroupCard>
}

describe('PluginGroupCard / 受控折叠语义', () => {
    it('默认 collapsed=true → 不渲染 children，aria-expanded=false；点击页头后渲染且 aria 翻转', () => {
        const {container, queryByTestId} = render(<Harness />)
        const header = container.querySelector('[data-name="test-plugin-group-header"]') as HTMLElement
        expect(header).toBeTruthy()
        expect(header.tagName).toBe('DIV')
        expect(header.getAttribute('aria-expanded')).toBe('false')
        expect(queryByTestId('child')).toBeNull()

        fireEvent.click(header)
        expect(queryByTestId('child')).toBeTruthy()
        expect(
            (container.querySelector('[data-name="test-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded'),
        ).toBe('true')
    })

    it('页头 data-name 与批量按钮 data-name 按传入值渲染', () => {
        const {container} = render(
            <Harness headerDataName="commands-dialog-plugin-group-header" batchDataName="commands-dialog-batch-toggle-button" onToggleBatch={vi.fn()} />,
        )
        expect(container.querySelector('[data-name="commands-dialog-plugin-group-header"]')).toBeTruthy()
        expect(container.querySelector('[data-name="commands-dialog-batch-toggle-button"]')).toBeTruthy()
    })
})

describe('PluginGroupCard / 批量按钮', () => {
    it('文案随 allEnabled 变化', () => {
        const {container, unmount} = render(<Harness allEnabled={false} onToggleBatch={vi.fn()} />)
        let btn = container.querySelector('[data-name="test-batch-toggle-button"]') as HTMLButtonElement
        expect(btn.textContent).toBe('全部启用')
        unmount()

        const r2 = render(<Harness allEnabled onToggleBatch={vi.fn()} />)
        btn = r2.container.querySelector('[data-name="test-batch-toggle-button"]') as HTMLButtonElement
        expect(btn.textContent).toBe('全部禁用')
    })

    it('点击批量按钮触发 onToggleBatch 且不切换折叠（stopPropagation）', () => {
        const onToggleBatch = vi.fn()
        const {container, queryByTestId} = render(<Harness allEnabled={false} onToggleBatch={onToggleBatch} />)
        expect(queryByTestId('child')).toBeNull()

        fireEvent.click(container.querySelector('[data-name="test-batch-toggle-button"]')!)
        expect(onToggleBatch).toHaveBeenCalledTimes(1)
        expect(queryByTestId('child')).toBeNull()
        expect(
            (container.querySelector('[data-name="test-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded'),
        ).toBe('false')
    })

    it('不传 onToggleBatch → 无批量按钮', () => {
        const {container} = render(<Harness />)
        expect(container.querySelector('[data-name="test-batch-toggle-button"]')).toBeNull()
    })
})

describe('PluginGroupCard / titleExtra', () => {
    it('传 titleExtra 时渲染', () => {
        const {getByTestId} = render(<Harness titleExtra={<span data-testid="extra">extra</span>} />)
        expect(getByTestId('extra')).toBeTruthy()
    })
})

describe('PluginGroupCard / 键盘与 DOM content model', () => {
    it('页头 Enter 切换折叠', () => {
        const {container, queryByTestId} = render(<Harness />)
        fireEvent.keyDown(container.querySelector('[data-name="test-plugin-group-header"]')!, {key: 'Enter'})
        expect(queryByTestId('child')).toBeTruthy()
        expect(
            (container.querySelector('[data-name="test-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded'),
        ).toBe('true')
    })

    it('页头 Space 切换折叠且 preventDefault 防滚动', () => {
        const {container, queryByTestId} = render(<Harness />)
        const notPrevented = fireEvent.keyDown(container.querySelector('[data-name="test-plugin-group-header"]')!, {key: ' '})
        expect(notPrevented).toBe(false)
        expect(queryByTestId('child')).toBeTruthy()
    })

    it('内层批量按钮 Enter / Space 不触发外层折叠', () => {
        const {container, queryByTestId} = render(<Harness allEnabled={false} onToggleBatch={vi.fn()} />)
        const batchBtn = container.querySelector('[data-name="test-batch-toggle-button"]') as HTMLButtonElement
        expect(queryByTestId('child')).toBeNull()

        fireEvent.keyDown(batchBtn, {key: 'Enter'})
        fireEvent.keyDown(batchBtn, {key: ' '})
        expect(queryByTestId('child')).toBeNull()
        expect(
            (container.querySelector('[data-name="test-plugin-group-header"]') as HTMLElement).getAttribute('aria-expanded'),
        ).toBe('false')
    })

    it('不存在 button 嵌套 button', () => {
        const {container} = render(<Harness allEnabled onToggleBatch={vi.fn()} />)
        expect(container.querySelectorAll('button button').length).toBe(0)
    })

    it('a11y：页头具备 role=button 与 tabIndex=0，aria-label 随折叠态变化', () => {
        const {container} = render(<Harness />)
        const header = container.querySelector('[data-name="test-plugin-group-header"]') as HTMLElement
        expect(header.getAttribute('role')).toBe('button')
        expect(header.getAttribute('tabindex')).toBe('0')
        expect(header.getAttribute('aria-label')).toBe('展开分组')

        fireEvent.click(header)
        expect(
            (container.querySelector('[data-name="test-plugin-group-header"]') as HTMLElement).getAttribute('aria-label'),
        ).toBe('折叠分组')
    })
})
