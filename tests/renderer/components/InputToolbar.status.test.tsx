// @vitest-environment jsdom
/**
 * InputToolbar — 运行态提示单元测试
 *
 * 覆盖需求：模型 + 阶段状态（"模型 思考中/响应中"）已合并至消息气泡底部
 * （MessageList statusNote），InputToolbar 不再渲染"模型 运行中..."文案，
 * 仅保留运行脉冲点作视觉反馈。
 *
 * 断言目标：
 * - isRunning 时不渲染"运行中"文案（由气泡 statusNote 承载）
 * - isRunning 时保留运行脉冲点
 * - 未运行时不显示运行态元素，显示输入提示
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import InputToolbar from '../../../src/renderer/components/InputToolbar'

// ── 子组件 mock：CacheRateTooltip 依赖 hooks（useMessageTokenStats / useWindowUsage），
//    ToolMenu 依赖 framer-motion/portal，均 mock 为轻量占位，聚焦状态断言 ──
vi.mock('../../../src/renderer/components/CacheRateTooltip', () => ({
    default: () => null,
}))
vi.mock('../../../src/renderer/components/ToolMenu', () => ({
    default: () => null,
}))

const BASE_PROPS = {
    isRunning: false,
    compactInProgress: false,
    needsSession: false,
    needsModel: false,
    pendingMessagesCount: 0,
    canSend: true,
    onSubmit: vi.fn(),
    onAbort: vi.fn(),
    onUploadFile: vi.fn(),
    onOpenDialog: vi.fn(),
    onOpenCommandPalette: vi.fn(),
}

describe('InputToolbar 运行态提示（模型+阶段文案已合并至气泡 statusNote）', () => {
    it('isRunning 时不渲染任何运行态文案/脉冲点（全部合并至气泡 statusNote）', () => {
        const {container} = render(
            <InputToolbar
                {...BASE_PROPS}
                isRunning
            />,
        )
        expect(screen.queryByText(/运行中/)).toBeNull()
        expect(screen.queryByText(/思考中/)).toBeNull()
        expect(container.querySelector('.animate-pulse')).toBeNull()
    })

    it('未运行时显示输入提示，不显示运行态元素', () => {
        render(<InputToolbar {...BASE_PROPS} isRunning={false}/>)
        expect(screen.getByText(/Shift\+Enter 换行，Enter 发送/)).toBeTruthy()
        expect(document.querySelector('.animate-pulse')).toBeNull()
    })
})
