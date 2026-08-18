// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import LlmLogsWindow from '../../../src/renderer/components/LlmLogsWindow'

/** 统一访问被 stub 的 electronAPI，避免 window.electronAPI 可空类型的 TS 报错 */
const api = (): any => window.electronAPI

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        initialTheme: 'dark',
        windowId: 'llm-logs',
        windowControls: {
            minimize: vi.fn(),
            maximize: vi.fn(),
            close: vi.fn(),
            isMaximized: vi.fn().mockResolvedValue(false),
            onMaximizedChange: vi.fn().mockReturnValue(() => {}),
        },
        getLlmLogEnabled: vi.fn().mockResolvedValue(false),
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('LlmLogsWindow 独立窗口', () => {
    it('渲染标题栏（含窗口控制按钮）', async () => {
        render(<LlmLogsWindow/>)
        expect(screen.getByRole('button', {name: '最小化'})).toBeTruthy()
        expect(screen.getByRole('button', {name: '最大化'})).toBeTruthy()
        expect(screen.getByRole('button', {name: '关闭'})).toBeTruthy()
    })

    it('点击关闭按钮调用 windowControls.close', async () => {
        render(<LlmLogsWindow/>)
        fireEvent.click(screen.getByRole('button', {name: '关闭'}))
        expect(api().windowControls.close).toHaveBeenCalled()
    })

    it('日志关闭态显示空状态提示', async () => {
        render(<LlmLogsWindow/>)
        expect(await screen.findByText('日志记录已关闭')).toBeTruthy()
    })
})
