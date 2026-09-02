// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen} from '@testing-library/react'
import ConfigDialogWindow, {DIALOG_CONFIG_KEYS} from '../../../src/renderer/components/ConfigDialogWindow'
import {CONFIG_DIALOG_TYPES, DIALOG_TITLES, DIALOG_SIZES} from '../../../src/main/utils/configWindow'

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

    it('挂载全局 TooltipPortal（独立窗口否则原生 title tooltip，不符合主题设计）', () => {
        stubApi('llm-config')
        render(<ConfigDialogWindow/>)
        expect(document.body.querySelector('.tooltip-portal')).toBeTruthy()
    })

    it('DIALOG_CONFIG 覆盖 18 种迁移类型（无遗漏）', () => {
        // 从测试文件读不到模块内部常量，改为断言各类型渲染不降级：
        // 白名单 18 种逐一渲染 fallback 不出现
        const types = ['llm-config', 'scheme-config', 'mcp', 'tool-manage', 'agents', 'skills',
            'plugins', 'commands', 'schedules', 'channels', 'prompt-scheme',
            'settings', 'conversations', 'tool-catalog', 'system-prompt', 'about',
            'llm-logs', 'usage']
        for (const t of types) {
            vi.unstubAllGlobals()
            stubApi(t)
            const {unmount} = render(<ConfigDialogWindow/>)
            expect(screen.queryByText(/未知配置类型/)).toBeNull()
            unmount()
        }
    })

    it('跨层一致性：主进程 CONFIG_DIALOG_TYPES 与 renderer DIALOG_CONFIG_KEYS 双向子集一致', () => {
        // 主进程白名单的每个 type 都必须配齐标题与尺寸，否则窗口空白/打不开
        for (const t of CONFIG_DIALOG_TYPES) {
            expect(DIALOG_TITLES, `DIALOG_TITLES 缺 ${t}`).toHaveProperty(t)
            expect(DIALOG_SIZES, `DIALOG_SIZES 缺 ${t}`).toHaveProperty(t)
        }
        // 主进程白名单 ⊆ renderer 可渲染集 且 renderer 渲染集 ⊆ 主进程白名单（双向一致）
        for (const t of CONFIG_DIALOG_TYPES) {
            expect(DIALOG_CONFIG_KEYS.has(t), `renderer 缺 ${t}`).toBe(true)
        }
        for (const t of DIALOG_CONFIG_KEYS) {
            expect(CONFIG_DIALOG_TYPES.has(t), `主进程白名单缺 ${t}`).toBe(true)
        }
    })
})
