// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render} from '@testing-library/react'
import ConversationSidebar from '../../../src/renderer/components/ConversationSidebar'

// 隔离 store 依赖（zustand 真实 store：直接 setState 控制折叠态 / 就绪状态）
import {useSidebarStore} from '../../../src/renderer/stores/sidebarStore'
import {useLLMStore} from '../../../src/renderer/stores/llmStore'
import {useModelSchemeStore} from '../../../src/renderer/stores/modelSchemeStore'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

vi.mock('../../../src/renderer/components/SchemeSelector', () => ({default: () => <div data-testid="scheme"/>}))

/**
 * 将系统状态推到 ready：
 * jsdom 下 persist 无数据（electronAPI 未注入），hasRehydrated 保持 false →
 * SystemStatusIndicator 默认显示「初始化...」，需显式 setState。
 */
function makeReadyState(): void {
    useLLMStore.setState({
        hasRehydrated: true,
        providers: [{id: 'p1', name: '测试服务商', type: 'openai', baseUrl: 'http://localhost', enabled: true, models: []} as any],
    })
    useModelSchemeStore.setState({
        hasRehydrated: true,
        schemes: [{id: 's1', name: '测试方案'} as any],
        activeSchemeId: 's1',
    })
    useConversationStore.setState({
        currentWorkspacePath: 'E:/workspace/media/hclaw',
        activeConversationId: 'conv-1',
    })
}

beforeEach(() => {
    makeReadyState()
})

describe('ConversationSidebar footer / 折叠态', () => {
    it('展开态渲染状态行 + 工具行（齿轮/方案/主题）', () => {
        useSidebarStore.setState({leftCollapsed: false})
        const {container} = render(<ConversationSidebar/>)
        // 状态行：系统已就绪文本存在
        expect(container.textContent).toContain('系统已就绪')
        // 工具行：方案选择器 + 主题按钮（动态 aria-label：默认 light →「切换到深色模式」）
        expect(container.querySelector('[data-testid="scheme"]')).not.toBeNull()
        expect(container.querySelector('[aria-label*="切换到" i]')).not.toBeNull()
        // 折叠按钮（status-row 右侧）
        expect(container.querySelector('[aria-label*="折叠"],[aria-label*="collapse" i]')).not.toBeNull()
    })

    it('折叠态渲染全部菜单项（与齿轮菜单同源 18 项）+ 展开按钮', () => {
        useSidebarStore.setState({leftCollapsed: true})
        const {container} = render(<ConversationSidebar/>)
        const icons = container.querySelector('[data-name="sidebar-collapsed-icons"]')
        expect(icons).not.toBeNull()
        expect(icons!.querySelectorAll('[data-name="collapsed-item"]').length).toBe(18)
        // 展开按钮：双入口设计 —— 新增底部按钮 + 右侧边缘既有按钮共用同一 aria-label，
        // 必须断言数量为 2 而非 not.toBeNull()，否则右侧边缘按钮会遮蔽底部按钮缺失的失败
        expect(container.querySelectorAll('[aria-label="展开侧边栏"]').length).toBe(2)
        // 折叠态全部菜单项的 label：SIDEBAR_MENU_GROUPS 平铺顺序（menuItems.tsx）
        const collapsedLabels = Array.from(
            icons!.querySelectorAll('[data-name="collapsed-item"]'), // 与点击按钮同元素，title/aria-label 均为 item.label
        ).map((el) => el.getAttribute('aria-label'))
        expect(collapsedLabels).toEqual([
            '方案', '模型', 'Agents', 'Skills', '命令', '工具', 'MCP', '权限', '渠道',
            '会话', '任务历史', '提示词', '插件', '定时任务', '设置', '日志', '用量', '关于',
        ])
    })
})
