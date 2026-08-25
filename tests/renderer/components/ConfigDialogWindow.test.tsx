// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen} from '@testing-library/react'
import ConfigDialogWindow from '../../../src/renderer/components/ConfigDialogWindow'

function stubApi(dialogType: string) {
    vi.stubGlobal('electronAPI', {
        initialTheme: 'dark',
        windowId: dialogType,
        dialogType,
        windowControls: {
            minimize: vi.fn(),
            maximize: vi.fn(),
            close: vi.fn(),
            isMaximized: vi.fn().mockResolvedValue(false),
            onMaximizedChange: vi.fn().mockReturnValue(() => {}),
        },
        // 部分 Dialog 挂载即调用（非可选链），需补齐避免渲染崩溃
        configGetHclawDir: vi.fn().mockResolvedValue(''),
        getAppVersion: vi.fn().mockResolvedValue('0.0.0'),
    })
}

beforeEach(() => {})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('ConfigDialogWindow 独立配置窗口入口', () => {
    it('按 --hclaw-dialog=llm-config 渲染服务商配置', () => {
        stubApi('llm-config')
        render(<ConfigDialogWindow/>)
        expect(screen.getByText('服务商配置')).toBeTruthy()
    })

    it('按 --hclaw-dialog=mcp 渲染 MCP 服务', () => {
        stubApi('mcp')
        render(<ConfigDialogWindow/>)
        expect(screen.getByText('MCP 服务')).toBeTruthy()
    })

    it('未知 dialogType 安全降级（不崩溃）', () => {
        stubApi('unknown-type')
        render(<ConfigDialogWindow/>)
        expect(screen.getByText(/未知配置类型/)).toBeTruthy()
    })

    it('DIALOG_CONFIG 覆盖 18 种迁移类型（无遗漏）', () => {
        // 从测试文件读不到模块内部常量，改为断言各类型渲染不降级：
        // 白名单 18 种逐一渲染 fallback 不出现
        const types = ['llm-config', 'scheme-config', 'mcp', 'tools', 'agents', 'skills',
            'plugins', 'commands', 'schedules', 'channels', 'prompt-config',
            'settings', 'conversations', 'tool-list', 'system-prompt', 'about',
            'llm-logs', 'usage']
        for (const t of types) {
            vi.unstubAllGlobals()
            stubApi(t)
            const {unmount} = render(<ConfigDialogWindow/>)
            expect(screen.queryByText(/未知配置类型/)).toBeNull()
            unmount()
        }
    })
})
