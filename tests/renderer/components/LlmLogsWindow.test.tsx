// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen} from '@testing-library/react'
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

describe('LlmLogsWindow 对话框形态组件（标题栏由 ConfigDialogWindow 统一壳提供）', () => {
    it('自身不渲染窗口控制按钮（由统一壳负责）', async () => {
        render(<LlmLogsWindow/>)
        expect(screen.queryByRole('button', {name: '关闭'})).toBeNull()
        expect(screen.queryByRole('button', {name: '最小化'})).toBeNull()
    })

    it('日志关闭态显示空状态提示与开启按钮', async () => {
        render(<LlmLogsWindow/>)
        expect(await screen.findByText('日志记录已关闭')).toBeTruthy()
        expect(screen.getByRole('button', {name: '开启日志记录'})).toBeTruthy()
    })

    it('日志开启态显示工具栏（记录数 / 刷新 / 暂停 / 清空）', async () => {
        api().getLlmLogEnabled = vi.fn().mockResolvedValue(true)
        render(<LlmLogsWindow/>)
        expect(await screen.findByText(/条记录/)).toBeTruthy()
        expect(screen.getByRole('button', {name: '刷新'})).toBeTruthy()
        expect(screen.getByRole('button', {name: '暂停记录'})).toBeTruthy()
        expect(screen.getByRole('button', {name: '清空'})).toBeTruthy()
    })
})
