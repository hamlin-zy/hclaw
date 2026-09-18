// @vitest-environment jsdom
/**
 * 六个设置 Tab 的渲染契约测试（T12 建立骨架，T13–T17 逐任务追加 describe）。
 * store 以 mock hook 提供（组件只消费 useSettingsStore() 与 getState()）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, cleanup, within, fireEvent} from '@testing-library/react'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'

const {mockState, mockHook} = vi.hoisted(() => {
    const state: any = {}
    const hook: any = (selector?: any) => (typeof selector === 'function' ? selector(state) : state)
    hook.getState = () => state
    return {mockState: state, mockHook: hook}
})

vi.mock('../../../../../src/renderer/stores/settingsStore', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    useSettingsStore: mockHook,
}))

import GeneralTab from '../../../../../src/renderer/components/settings/tabs/GeneralTab'
import AppearanceTab from '../../../../../src/renderer/components/settings/tabs/AppearanceTab'
import AgentTab from '../../../../../src/renderer/components/settings/tabs/AgentTab'
import ModelTab from '../../../../../src/renderer/components/settings/tabs/ModelTab'
import ChannelsTab from '../../../../../src/renderer/components/settings/tabs/ChannelsTab'
import ShortcutsTab from '../../../../../src/renderer/components/settings/tabs/ShortcutsTab'

beforeEach(() => {
    cleanup()
    Object.assign(mockState, {
        settings: {...DEFAULT_SETTINGS, fullSkillDescriptions: false},
        pendingSettings: null,
        isDirty: false,
        loadSettings: vi.fn(async () => true),
        updatePending: vi.fn(),
        updateSettings: vi.fn(async () => {}),
        saveSettings: vi.fn(async () => {}),
        discardChanges: vi.fn(),
        resetFieldsToDefault: vi.fn(),
        resetAllToDefault: vi.fn(),
    })
    // 只补 electronAPI，不整体替换 window：jsdom 的 window 还有 addEventListener 等方法，
    // 整体替换会让 framer-motion（CollapsibleSection 的高度过渡）挂载失败
    ;(globalThis as any).window.electronAPI = {
        configWrite: vi.fn(async () => true),
        configRead: vi.fn(async () => null),
        settingsUpdate: vi.fn(async () => ({success: true})),
        backgroundList: vi.fn(async () => []),
    }
})

describe('GeneralTab', () => {
    it('渲染分节与关键字段（系统 / 新会话默认）', () => {
        render(<GeneralTab/>)
        expect(screen.getByText('系统配置目录')).toBeTruthy()
        expect(screen.getByText('新会话默认安全模式')).toBeTruthy()
        expect(screen.getByText('新会话默认显示模式')).toBeTruthy()
        expect(screen.getByText('技能目录详细描述')).toBeTruthy()
        expect(screen.getByText('链接打开方式')).toBeTruthy()
        expect(screen.getByText('恢复本页默认')).toBeTruthy()
    })

    // 分节归属是 spec §3.1 的硬约束（T12 复核回归：曾误置于「新会话默认」）。
    // 平铺断言抓不到归属错误，故按分节边界断言。
    it('「技能目录详细描述」归属「系统」分节且在「链接打开方式」之后', () => {
        render(<GeneralTab/>)
        const systemSection = screen.getByText('系统').closest('section')!
        const newSessionSection = screen.getByText('新会话默认').closest('section')!
        const linkRow = within(systemSection).getByText('链接打开方式')
        const skillRow = within(systemSection).getByText('技能目录详细描述')
        expect(linkRow.compareDocumentPosition(skillRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(within(newSessionSection).queryByText('技能目录详细描述')).toBeNull()
    })
})

describe('AppearanceTab', () => {
    it('渲染主题与背景分节 + 页重置', () => {
        render(<AppearanceTab/>)
        expect(screen.getByText('外观')).toBeTruthy()
        expect(screen.getByText('本地图片背景')).toBeTruthy()
        expect(screen.getByText('恢复本页默认')).toBeTruthy()
    })

    it('历史背景图仅渲染最近 50 张（state 全量；超出提示总数）', async () => {
        mockState.settings = {
            ...DEFAULT_SETTINGS,
            fullSkillDescriptions: false,
            ui: {...DEFAULT_SETTINGS.ui, background: {...DEFAULT_SETTINGS.ui.background, enabled: true}},
        }
        const list = Array.from({length: 60}, (_, i) => ({path: `bg-${i}.png`, name: `背景图 ${i}.png`}))
        ;(globalThis as any).window.electronAPI.backgroundList = vi.fn(async () => list)
        render(<AppearanceTab/>)
        expect((await screen.findAllByTestId('bg-thumb')).length).toBe(50)
        expect(screen.getByText('共 60 张，仅显示最近 50')).toBeTruthy()
    })
})

describe('AgentTab', () => {
    it('渲染分节、命名表标签与页重置', () => {
        render(<AgentTab/>)
        // 分节
        expect(screen.getByText('任务循环')).toBeTruthy()
        expect(screen.getByText('上下文交接')).toBeTruthy()
        expect(screen.getAllByText('循环检测').length).toBeGreaterThan(0) // 分节名与开关标签可能同时存在
        expect(screen.getByText('子 Agent（委派）')).toBeTruthy()
        expect(screen.getByText('高级·超时与重试')).toBeTruthy()
        // 命名表标签（规格 §4.4 全量落地）
        expect(screen.getByText('最大轮次')).toBeTruthy()
        expect(screen.getByText('检测阈值')).toBeTruthy()
        expect(screen.getByText('阈值计算方式')).toBeTruthy()
        expect(screen.getByText('上下文溢出处理')).toBeTruthy()
        // R1：「最大尝试次数」在默认折叠的「高级·超时与重试」内——折叠时不渲染子树，先固化默认折叠再展开
        expect(screen.queryByText('最大尝试次数')).toBeNull()
        fireEvent.click(screen.getByText('高级·超时与重试'))
        expect(screen.getByText('最大尝试次数')).toBeTruthy()
        // R20：两字段按 thresholdMode 互斥显示（旧行为）；默认 DEFAULT_SETTINGS.agent.handoffThresholdMode='ratio'
        expect(screen.getByText('交接引导阈值')).toBeTruthy()
        expect(screen.queryByText('交接阈值大小')).toBeNull()
        expect(screen.getByText('最大并发数')).toBeTruthy()
        expect(screen.getByText('委派深度')).toBeTruthy()
        expect(screen.getByText('恢复本页默认')).toBeTruthy()
    })
})

describe('ModelTab', () => {
    it('渲染模型参数字段', () => {
        render(<ModelTab/>)
        expect(screen.getByText('默认最大 Token 数')).toBeTruthy()
        expect(screen.getByText('默认温度')).toBeTruthy()
        expect(screen.getByText('图片压缩质量')).toBeTruthy()
        expect(screen.getByText('恢复本页默认')).toBeTruthy()
    })
})

describe('ChannelsTab', () => {
    it('渲染 IM 配置字段', () => {
        render(<ChannelsTab/>)
        expect(screen.getByText('连接后发送打招呼信息')).toBeTruthy()
        expect(screen.getByText('连接超时时间')).toBeTruthy()
        expect(screen.getByText('恢复本页默认')).toBeTruthy()
    })
})

describe('ShortcutsTab', () => {
    it('渲染快捷键区与「键位恢复默认」', () => {
        render(<ShortcutsTab/>)
        expect(screen.getByText('键位恢复默认')).toBeTruthy()
        expect(screen.getByText('恢复本页默认')).toBeTruthy()
    })

    // S2 护栏：四卡由单一 GROUP_CARDS 驱动（3 可自定义组 + Agent & 权限尾卡），
    // 卡片顺序 == 文档序，且每卡内「自定义行（可改键）在前、静态只读行在后」。
    // 调换 GROUP_CARDS 顺序、把 staticItems 挪到自定义行之前、或删卡都会让平铺断言静默通过，
    // 故按 compareDocumentPosition（同文件 GeneralTab 用例惯例）断言文档序。
    it('S2 四卡标题与文档序固定，卡内自定义行先于静态行', () => {
        render(<ShortcutsTab/>)
        const before = (a: string, b: string) => {
            expect(
                screen.getByText(a).compareDocumentPosition(screen.getByText(b))
                & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy()
        }

        // 1. 四卡标题（文档序：面板 & 窗口 → 输入 & 会话 → 全局 → Agent & 权限）
        const cardTitles = ['面板 & 窗口', '输入 & 会话', '全局', 'Agent & 权限']
        for (const title of cardTitles) expect(screen.getByText(title)).toBeTruthy()
        for (let i = 1; i < cardTitles.length; i++) before(cardTitles[i - 1], cardTitles[i])

        // 2. 卡内「自定义行在静态行之前」（跨卡两处抽验）
        before('切换左侧栏', '功能菜单（左下角三横线）')            // 面板 & 窗口
        before('呼出短语选择器', '发送消息')                        // 输入 & 会话（末自定义 → 首静态）

        // 3. 静态块内部顺序
        before('发送消息', '换行')
        before('换行', '粘贴剪贴板内容')
        before('粘贴剪贴板内容', '查找消息')
        before('中断 Agent 执行', '允许当前工具调用')

        // 4. 全局卡内容（可自定义；仅一个自定义行时卡片仍须存在）
        expect(screen.getByText('隐藏 / 显示 HClaw 窗口')).toBeTruthy()
    })
})
