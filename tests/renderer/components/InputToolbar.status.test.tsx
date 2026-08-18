// @vitest-environment jsdom
/**
 * InputToolbar — 运行态模型提示信息格式单元测试
 *
 * 覆盖需求：InputArea 下方提示信息从「{模型名}（{api类型}） 运行中...」
 * 改为「{服务商名称}/{模型名称} 运行中...」
 *
 * 断言目标：
 * - 有 provider 时渲染「OpenRouter/deepseek-v3 运行中...」（不再带括号、不再 toLowerCase）
 * - 无 provider 时渲染「deepseek-v3 运行中...」（回退格式）
 * - 未运行时不渲染运行态提示
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import InputToolbar from '../../../src/renderer/components/InputToolbar'

// ── 子组件 mock：CacheRateTooltip 依赖 hooks（useMessageTokenStats / useWindowUsage），
//    ToolMenu 依赖 framer-motion/portal，均 mock 为轻量占位，聚焦状态文案断言 ──
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
    agentState: {currentModelProvider: undefined, currentModelName: undefined},
    pendingMessagesCount: 0,
    canSend: true,
    onSubmit: vi.fn(),
    onAbort: vi.fn(),
    onUploadFile: vi.fn(),
    onOpenDialog: vi.fn(),
    onOpenCommandPalette: vi.fn(),
}

describe('InputToolbar 运行态模型提示信息格式', () => {
    it('有 providerName 时渲染「{服务商名称}/{模型名称} 运行中...」', () => {
        render(
            <InputToolbar
                {...BASE_PROPS}
                isRunning
                agentState={{currentModelProvider: 'OpenRouter', currentModelName: 'deepseek-v3'}}
            />,
        )
        expect(screen.getByText(/OpenRouter\/deepseek-v3 运行中/)).toBeTruthy()
    })

    it('provider 为小写服务商名时不转小写、不显示括号（保留原始名称）', () => {
        render(
            <InputToolbar
                {...BASE_PROPS}
                isRunning
                agentState={{currentModelProvider: 'Ollama', currentModelName: 'qwen3:8b'}}
            />,
        )
        expect(screen.getByText(/Ollama\/qwen3:8b 运行中/)).toBeTruthy()
        expect(screen.queryByText(/（/)).toBeNull()
        expect(screen.queryByText(/ollama/)).toBeNull()
    })

    it('无 provider 时回退渲染「{模型名称} 运行中...」（兼容旧事件）', () => {
        render(
            <InputToolbar
                {...BASE_PROPS}
                isRunning
                agentState={{currentModelName: 'deepseek-v3'}}
            />,
        )
        expect(screen.getByText(/deepseek-v3 运行中/)).toBeTruthy()
    })

    it('未运行时不渲染运行态提示', () => {
        render(
            <InputToolbar
                {...BASE_PROPS}
                isRunning={false}
                agentState={{currentModelProvider: 'OpenRouter', currentModelName: 'deepseek-v3'}}
            />,
        )
        expect(screen.queryByText(/运行中/)).toBeNull()
    })
})
