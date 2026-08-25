// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import ConvModeSegs from '../../../src/renderer/components/ConvModeSegs'

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
        expect(screen.getByText('紧凑')).toBeTruthy()
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
