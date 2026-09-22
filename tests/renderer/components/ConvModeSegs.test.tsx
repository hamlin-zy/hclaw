// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import ConvModeSegs, {ModeSpaceContext} from '../../../src/renderer/components/ConvModeSegs'

const {convPermMock, convDispMock} = vi.hoisted(() => ({
    convPermMock: vi.fn(async () => {}),
    convDispMock: vi.fn(async () => {}),
}))

vi.mock('../../../src/renderer/stores/agentStore', async () => {
    const actual = await vi.importActual<typeof import('../../../src/renderer/stores/agentStore')>('../../../src/renderer/stores/agentStore')
    // 轻量替换 action；state 用真实 store 便于 setState 控制
    const {useAgentStore} = actual
    const original = useAgentStore.getState()
    useAgentStore.setState({
        ...original,
        setConvPermissionMode: convPermMock,
        setConvDisplayMode: convDispMock,
    })
    return actual
})

vi.mock('../../../src/renderer/stores/conversationStore', async () => {
    const actual = await vi.importActual<typeof import('../../../src/renderer/stores/conversationStore')>('../../../src/renderer/stores/conversationStore')
    const {useConversationStore} = actual
    useConversationStore.setState({activeConversationId: 'conv-a'})
    return actual
})

describe('ConvModeSegs 会话级分段控件', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('渲染安全模式二段 + 显示模式三段', () => {
        render(<ConvModeSegs/>)
        expect(screen.getByText('自动')).toBeTruthy()
        expect(screen.getByText('安全')).toBeTruthy()
        expect(screen.getByText('详细')).toBeTruthy()
        expect(screen.getByText('简洁')).toBeTruthy()
        expect(screen.getByText('极简')).toBeTruthy()
    })

    it('点击「自动」→ setConvPermissionMode(convId, auto)', () => {
        render(<ConvModeSegs/>)
        fireEvent.click(screen.getByText('自动'))
        expect(convPermMock).toHaveBeenCalledWith('conv-a', 'auto')
    })

    it('点击「简洁」→ setConvDisplayMode(convId, compact)', () => {
        render(<ConvModeSegs/>)
        fireEvent.click(screen.getByText('简洁'))
        expect(convDispMock).toHaveBeenCalledWith('conv-a', 'compact')
    })
})

describe('ConvModeSegs 挤压档位（ModeSpaceContext）', () => {
    // 档位阈值：>=243 完整展开；>=117 两组折叠；>=67 仅显示模式折叠；<67 隐藏
    const renderAt = (w: number | null) => {
        const {container} = render(
            <ModeSpaceContext.Provider value={w}>
                <ConvModeSegs/>
            </ModeSpaceContext.Provider>,
        )
        return {
            collapsed: () => Array.from(container.querySelectorAll('[data-name^="conv-mode-collapsed-"]'))
                .map((el) => el.getAttribute('data-name')),
            fullGroups: () => container.querySelectorAll('.seg').length,
            container,
        }
    }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('null（未测量）→ 完整展开（回退旧行为）', () => {
        const {collapsed, fullGroups} = renderAt(null)
        expect(collapsed()).toEqual([])
        expect(fullGroups()).toBe(2)
    })

    it('243（恰为完整展开占宽）→ 完整展开', () => {
        const {collapsed, fullGroups} = renderAt(243)
        expect(collapsed()).toEqual([])
        expect(fullGroups()).toBe(2)
    })

    it('242（差 1px）→ 两组折叠胶囊', () => {
        const {collapsed, fullGroups} = renderAt(242)
        expect(collapsed()).toEqual(['conv-mode-collapsed-安全模式', 'conv-mode-collapsed-显示模式'])
        expect(fullGroups()).toBe(0)
    })

    it('117（恰为两组折叠占宽）→ 两组折叠胶囊', () => {
        const {collapsed} = renderAt(117)
        expect(collapsed()).toEqual(['conv-mode-collapsed-安全模式', 'conv-mode-collapsed-显示模式'])
    })

    it('116（放不下两组）→ 仅显示模式折叠胶囊', () => {
        const {collapsed} = renderAt(116)
        expect(collapsed()).toEqual(['conv-mode-collapsed-显示模式'])
    })

    it('67（恰为单组折叠占宽）→ 仅显示模式折叠胶囊', () => {
        const {collapsed} = renderAt(67)
        expect(collapsed()).toEqual(['conv-mode-collapsed-显示模式'])
    })

    it('66（放不下单组）→ 整组隐藏（不渲染任何折叠元素）', () => {
        const {collapsed, fullGroups, container} = renderAt(66)
        expect(collapsed()).toEqual([])
        expect(fullGroups()).toBe(0)
        expect(container.innerHTML).toBe('')
    })
})

describe('ConvModeSegs 折叠胶囊键盘路径', () => {
    // 116 → 仅「显示模式」折叠为单选胶囊（非只读，具备键盘路径）
    const renderCollapsed = () => {
        const {container} = render(
            <ModeSpaceContext.Provider value={116}>
                <ConvModeSegs/>
            </ModeSpaceContext.Provider>,
        )
        const seg = container.querySelector('[data-name="conv-mode-collapsed-显示模式"]') as HTMLElement
        const pill = seg.querySelector('.seg-collapsed-pill') as HTMLElement
        return {seg, pill}
    }
    // 弹层经 createPortal 挂到 body，故从 document 查询
    const options = () => Array.from(document.querySelectorAll('.seg-pop [role="option"]')) as HTMLElement[]
    const openByKeyboard = (pill: HTMLElement) => {
        pill.focus()
        fireEvent.keyDown(pill, {key: 'Enter'})
    }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('Enter 打开选项层并把焦点移入首项', () => {
        const {pill} = renderCollapsed()
        openByKeyboard(pill)
        expect(options().map((o) => o.textContent)).toEqual(['详细', '简洁', '极简'])
        expect(document.activeElement).toBe(options()[0])
    })

    it('方向键在选项间移焦，到边界停住（不循环）', () => {
        const {pill} = renderCollapsed()
        openByKeyboard(pill)
        const opts = options()
        fireEvent.keyDown(opts[0], {key: 'ArrowDown'})
        expect(document.activeElement).toBe(opts[1])
        fireEvent.keyDown(opts[1], {key: 'ArrowDown'})
        expect(document.activeElement).toBe(opts[2])
        fireEvent.keyDown(opts[2], {key: 'ArrowDown'}) // 末项再向下：停住
        expect(document.activeElement).toBe(opts[2])
        fireEvent.keyDown(opts[2], {key: 'ArrowUp'})
        expect(document.activeElement).toBe(opts[1])
    })

    it('Enter 选中当前项 → 应用选择、关闭弹层、焦点归还胶囊', () => {
        const {pill} = renderCollapsed()
        openByKeyboard(pill)
        fireEvent.keyDown(options()[0], {key: 'ArrowDown'})
        fireEvent.keyDown(options()[1], {key: 'Enter'})
        expect(convDispMock).toHaveBeenCalledWith('conv-a', 'compact')
        expect(document.querySelector('.seg-pop')).toBeNull()
        expect(document.activeElement).toBe(pill)
    })

    it('Space 等价单击（preventDefault 且不双触发）', () => {
        const {pill} = renderCollapsed()
        openByKeyboard(pill)
        // fireEvent 返回 false ⇔ 事件被 preventDefault（Space 不再滚动容器 / 不触发原生 click）
        expect(fireEvent.keyDown(options()[0], {key: ' '})).toBe(false)
        expect(convDispMock).toHaveBeenCalledTimes(1)
        expect(convDispMock).toHaveBeenCalledWith('conv-a', 'detailed')
        expect(document.activeElement).toBe(pill)
    })

    it('Escape 关闭弹层且不改变选择，焦点归还胶囊', () => {
        const {pill} = renderCollapsed()
        openByKeyboard(pill)
        fireEvent.keyDown(options()[1], {key: 'Escape'})
        expect(convDispMock).not.toHaveBeenCalled()
        expect(document.querySelector('.seg-pop')).toBeNull()
        expect(document.activeElement).toBe(pill)
    })

    it('Tab 落焦到第 2 项后按 Enter → 选中的是焦点项（非首项）', () => {
        const {pill} = renderCollapsed()
        openByKeyboard(pill)
        const opts = options()
        expect(document.activeElement).toBe(opts[0])
        // jsdom 不实现 Tab 焦点移动，用 .focus() 模拟 Tab 落焦（触发 onFocus）
        opts[1].focus()
        expect(document.activeElement).toBe(opts[1])
        fireEvent.keyDown(opts[1], {key: 'Enter'})
        expect(convDispMock).toHaveBeenCalledTimes(1)
        expect(convDispMock).toHaveBeenCalledWith('conv-a', 'compact')
        expect(document.querySelector('.seg-pop')).toBeNull()
        expect(document.activeElement).toBe(pill)
    })

    it('Tab 落焦到第 3 项后按 Space → 选中的是焦点项', () => {
        const {pill} = renderCollapsed()
        openByKeyboard(pill)
        const opts = options()
        opts[2].focus()
        expect(document.activeElement).toBe(opts[2])
        expect(fireEvent.keyDown(opts[2], {key: ' '})).toBe(false)
        expect(convDispMock).toHaveBeenCalledTimes(1)
        expect(convDispMock).toHaveBeenCalledWith('conv-a', 'ultra-compact')
        expect(document.activeElement).toBe(pill)
    })

    it('鼠标 hover 打开不抢焦点（鼠标路径零变化）', () => {
        const {seg} = renderCollapsed()
        fireEvent.mouseEnter(seg)
        expect(options()).toHaveLength(3)
        expect(document.activeElement).not.toBe(options()[0])
        expect(document.activeElement).toBe(document.body)
    })

    it('hover 已打开后再用键盘接入：焦点同样进入首项', () => {
        const {seg, pill} = renderCollapsed()
        fireEvent.mouseEnter(seg)
        pill.focus()
        fireEvent.keyDown(pill, {key: 'Enter'})
        expect(document.activeElement).toBe(options()[0])
    })
})
