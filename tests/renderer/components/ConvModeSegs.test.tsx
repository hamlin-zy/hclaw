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
