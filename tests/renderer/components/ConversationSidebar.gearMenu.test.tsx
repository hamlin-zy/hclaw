// @vitest-environment jsdom
/**
 * SidebarGearMenu 两级抽屉测试（Task 3）。
 *
 * 契约测试：hover 桥接时序（120/200ms）、R-32 shadow zone 吞 click、
 * 红点数据源映射（4 类 store → UpdateCtx）、状态机。
 * 几何常量一律从 ProjectGroupDrawer import，禁止硬编码。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act, waitFor, cleanup} from '@testing-library/react'
import {SIDEBAR_MENU_NODES} from '../../../src/renderer/components/sidebar/menuItems'
import {PANEL_OPEN_DELAY_MS, PANEL_CLOSE_GRACE_MS} from '../../../src/renderer/components/ProjectGroupDrawer'

vi.mock('../../../src/renderer/components/SchemeSelector', () => ({default: () => <div data-testid="scheme"/>}))
vi.mock('../../../src/renderer/services/newConversation', () => ({
    newConversation: vi.fn(async () => 'conv-new'),
}))

import ConversationSidebar, {
    GEAR_PANEL_ITEM_ROW_HEIGHT,
    GEAR_PANEL_CHROME_HEIGHT,
    computeSidebarPanelGeometry,
} from '../../../src/renderer/components/ConversationSidebar'
import {useSidebarStore} from '../../../src/renderer/stores/sidebarStore'
import {useUpdaterStore} from '../../../src/renderer/stores/updaterStore'
import {usePluginUpdateStore} from '../../../src/renderer/stores/pluginUpdateStore'
import {useRepoUpdateStore} from '../../../src/renderer/stores/repoUpdateStore'
import {useMcpUpdateStore} from '../../../src/renderer/stores/mcpUpdateStore'
import {useLLMStore} from '../../../src/renderer/stores/llmStore'
import {useModelSchemeStore} from '../../../src/renderer/stores/modelSchemeStore'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

/** 把系统状态推到 ready，避免初始化态干扰渲染 */
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
        activeConversationId: null,
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    // 更新红点 store 全部归零（plugin/repo/mcp 走 createUpdateStore，用 clear() 保证类型安全）
    useUpdaterStore.setState({result: null})
    usePluginUpdateStore.getState().clear()
    useRepoUpdateStore.getState().clear()
    useMcpUpdateStore.getState().clear()
    // 4 个 update store 无持久化但为了保险也归零
    useSidebarStore.setState({leftCollapsed: false})
    makeReadyState()
    // electronAPI mock（openMenuItem 分发）
    ;(window as any).electronAPI = {
        openConfigWindow: vi.fn(),
        openLlmLogsWindow: vi.fn(),
        openUsageStatsWindow: vi.fn(),
    }
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

/** 打开汉堡菜单（一级抽屉） */
function openGear(): HTMLElement {
    const btn = screen.getByRole('button', {name: '功能菜单'}) as HTMLElement
    fireEvent.click(btn)
    return btn
}

/** 取 drawer 中的 group 节点 button（按索引） */
function groupNode(index = 0): HTMLElement {
    const nodes = document.querySelectorAll('[data-name="sidebar-gear-node-list"] button[data-node-id^="group:"]')
    expect(nodes.length, '至少要有 group 节点').toBeGreaterThan(index)
    return nodes[index] as HTMLElement
}

describe('SidebarGearMenu 两级抽屉', () => {
    it('T15: hamburger click 打开一级抽屉，含 7 节点（5 group + 2 direct）', () => {
        render(<ConversationSidebar/>)
        openGear()
        const drawer = document.querySelector('[data-name="sidebar-gear-primary-drawer"]')
        expect(drawer).not.toBeNull()
        const nodes = drawer!.querySelectorAll('[data-name="sidebar-gear-node-list"] > *')
        expect(nodes.length).toBe(7)
        // 与 SIDEBAR_MENU_NODES 节点数一致（结构契约）
        expect(SIDEBAR_MENU_NODES.length).toBe(7)
    })

    it('T16: click group 节点打开二级面板，项数 = 该 group 的 items 数', () => {
        render(<ConversationSidebar/>)
        openGear()
        const firstGroup = SIDEBAR_MENU_NODES[0]
        expect(firstGroup.kind).toBe('group')
        if (firstGroup.kind !== 'group') return
        fireEvent.click(groupNode(0))
        const panel = document.querySelector('[data-name="sidebar-gear-secondary-panel"]')
        expect(panel).not.toBeNull()
        const items = panel!.querySelectorAll('[data-name="sidebar-gear-secondary-item"]')
        expect(items.length).toBe(firstGroup.items.length)
        // 二级面板带 data-panel-node-id（可追溯到 group）
        expect(panel!.getAttribute('data-panel-node-id')).toBe(`group:${firstGroup.group}`)
    })

    it('T17: Alt 快捷键派发 hclaw:toggle-gear-menu 切换抽屉', () => {
        render(<ConversationSidebar/>)
        fireEvent(window, new CustomEvent('hclaw:toggle-gear-menu'))
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).not.toBeNull()
        fireEvent(window, new CustomEvent('hclaw:toggle-gear-menu'))
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).toBeNull()
    })

    it('T18: click outside 关闭抽屉（mousedown 判定）', async () => {
        render(<ConversationSidebar/>)
        openGear()
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).not.toBeNull()
        fireEvent.mouseDown(document.body)
        await waitFor(() => {
            expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).toBeNull()
        })
    })

    it('T19: Esc 关闭抽屉（含二级面板）', async () => {
        render(<ConversationSidebar/>)
        vi.useFakeTimers()
        openGear()
        fireEvent.click(groupNode(0))
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
        fireEvent(document, new KeyboardEvent('keydown', {key: 'Escape'}))
        await act(async () => {
            await Promise.resolve()
        })
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).toBeNull()
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).toBeNull()
    })

    it('T20: hover group 120ms 后打开面板（时序契约 = PANEL_OPEN_DELAY_MS）', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()
        const groupBtn = groupNode(0)
        fireEvent.mouseEnter(groupBtn)
        // 未到期：面板未打开
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).toBeNull()
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS - 1)
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).toBeNull()
        vi.advanceTimersByTime(1)
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
    })

    it('T21: click group 立即打开面板（跳过 120ms hover 延时）', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()
        fireEvent.click(groupNode(0))
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
        // 时间未推进 → 证明不是靠定时器，是 click 立即生效
        vi.advanceTimersByTime(0)
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
    })

    it('T22: hover group → 面板开 → mouseLeave group → mouseEnter panel，面板保持打开', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()
        const groupBtn = groupNode(0)
        fireEvent.mouseEnter(groupBtn)
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS)
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
        // 离开 group → grace 期
        fireEvent.mouseLeave(groupBtn)
        vi.advanceTimersByTime(PANEL_CLOSE_GRACE_MS - 50)
        // grace 未到期，面板还在
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
        // 进入面板 → 取消 close timer
        const panel = document.querySelector('[data-name="sidebar-gear-secondary-panel"]') as HTMLElement
        fireEvent.mouseEnter(panel)
        // grace 到期后（+300ms）面板仍开
        vi.advanceTimersByTime(300)
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
    })

    it('T23: 离开一级抽屉 group 与面板超过 200ms → 面板关闭（grace 到期）', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()
        const groupBtn = groupNode(0)
        fireEvent.mouseEnter(groupBtn)
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS)
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).not.toBeNull()
        // 离开 group，不进入面板
        fireEvent.mouseLeave(groupBtn)
        vi.advanceTimersByTime(PANEL_CLOSE_GRACE_MS)
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).toBeNull()
    })

    it('T24: R-32 shadow zone 吞 click 不关抽屉（pointer 从面板向下进入空白区不触发 clickOutside）', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()
        fireEvent.click(groupNode(0))
        await act(async () => {})
        // shadow zone 应存在
        const shadow = document.querySelector('[data-name="sidebar-gear-panel-shadow-zone"]') as HTMLElement
        expect(shadow).not.toBeNull()
        // click / mousedown 落到 shadow 上 → 应被 stopPropagation 吞掉
        fireEvent.mouseDown(shadow)
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).not.toBeNull()
        // 一级抽屉仍然开着
        fireEvent.click(shadow)
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).not.toBeNull()
    })

    it('T25: click 二级项 → openMenuItem(type) 并关闭全部', async () => {
        vi.useFakeTimers()
        const openConfigSpy = vi.fn()
        ;(window as any).electronAPI = {
            openConfigWindow: openConfigSpy,
            openLlmLogsWindow: vi.fn(),
            openUsageStatsWindow: vi.fn(),
        }
        render(<ConversationSidebar/>)
        openGear()
        fireEvent.click(groupNode(0))
        await act(async () => {})
        // 第一个 group (模型配置) 第一个项 = 模型方案 (scheme-config)
        const panel = document.querySelector('[data-name="sidebar-gear-secondary-panel"]')!
        const panelItem = panel.querySelector('[data-name="sidebar-gear-secondary-item"]') as HTMLElement
        const itemType = panelItem.getAttribute('data-item-type')!
        expect(itemType).toBe('scheme-config')
        fireEvent.click(panelItem)
        await act(async () => {})
        expect(openConfigSpy).toHaveBeenCalledWith('scheme-config')
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).toBeNull()
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).toBeNull()
    })

    it('T26: click direct 节点（settings）→ openConfigWindow("settings") 并关闭抽屉', async () => {
        const openConfigSpy = vi.fn()
        ;(window as any).electronAPI = {
            openConfigWindow: openConfigSpy,
            openLlmLogsWindow: vi.fn(),
            openUsageStatsWindow: vi.fn(),
        }
        render(<ConversationSidebar/>)
        openGear()
        const settingsNode = document.querySelector('[data-name="sidebar-gear-node-list"] button[data-node-id="direct:settings"]') as HTMLElement
        expect(settingsNode).not.toBeNull()
        fireEvent.click(settingsNode)
        await act(async () => {})
        expect(openConfigSpy).toHaveBeenCalledWith('settings')
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).toBeNull()
    })

    it('T27: 一级节点红点 = nodeHasUpdate 结果（能力中心组命中 skills → dot 存在）', () => {
        useRepoUpdateStore.getState().setRepoUpdates({'local/skills': true})
        render(<ConversationSidebar/>)
        openGear()
        const abilityGroup = document.querySelector('[data-name="sidebar-gear-node-list"] button[data-node-id="group:能力中心"]') as HTMLElement
        expect(abilityGroup).not.toBeNull()
        expect(abilityGroup.querySelector('.rounded-full.bg-red-500')).not.toBeNull()
        // 其他 group 未命中 → 无红点（能力中心之外的 group）
        const modelGroup = document.querySelector('[data-name="sidebar-gear-node-list"] button[data-node-id="group:模型配置"]') as HTMLElement
        expect(modelGroup.querySelector('.rounded-full.bg-red-500')).toBeNull()
    })

    it('T28: 二级项红点 = itemHasUpdate 结果（skills 项命中 repoHasUpdate → dot 存在）', async () => {
        vi.useFakeTimers()
        useRepoUpdateStore.getState().setRepoUpdates({'local/skills': true})
        render(<ConversationSidebar/>)
        openGear()
        const abilityGroup = document.querySelector('[data-name="sidebar-gear-node-list"] button[data-node-id="group:能力中心"]') as HTMLElement
        expect(abilityGroup).not.toBeNull()
        fireEvent.click(abilityGroup)
        await act(async () => {})
        const skillsItem = document.querySelector('[data-name="sidebar-gear-secondary-item"][data-item-type="skills"]') as HTMLElement
        expect(skillsItem).not.toBeNull()
        expect(skillsItem.querySelector('.rounded-full.bg-red-500')).not.toBeNull()
        // 未命中的项（agents）无红点
        const agentsItem = document.querySelector('[data-name="sidebar-gear-secondary-item"][data-item-type="agents"]') as HTMLElement
        expect(agentsItem.querySelector('.rounded-full.bg-red-500')).toBeNull()
    })

    it('T30: hover 桥接死锁防护——mouseEnter <120ms 后 mouseLeave，open timer 到期也不打开', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()
        const groupBtn = groupNode(0)
        // t=0：mouseEnter 触发 open timer（120ms 后 fire）
        fireEvent.mouseEnter(groupBtn)
        // t=100：未到 open delay，此时 panelNodeId 仍为 null
        await act(async () => {
            vi.advanceTimersByTime(100)
        })
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).toBeNull()
        // t=100：立即 mouseLeave（尚未打开面板）→ 应清 open timer
        fireEvent.mouseLeave(groupBtn)
        // t=300：open timer 应已被清，面板仍应关闭（关键断言）
        await act(async () => {
            vi.advanceTimersByTime(200)
        })
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]')).toBeNull()
    })

    it('契约：hamburger 按钮 data-name 保留旧值（未改）', () => {
        render(<ConversationSidebar/>)
        const btn = screen.getByRole('button', {name: '功能菜单'}) as HTMLElement
        expect(btn.getAttribute('data-name')).toBe('conversation-sidebar-menu-toggle-button')
    })

    it('契约：4 类更新源全部命中 → hamburger 显示红点', () => {
        useUpdaterStore.setState({result: {status: 'update-available'} as any})
        usePluginUpdateStore.getState().setPluginUpdates({'demo': true})
        useRepoUpdateStore.getState().setRepoUpdates({'demo': true})
        useMcpUpdateStore.getState().setMcpUpdates({'demo': true})
        render(<ConversationSidebar/>)
        // hamburger 内的红点（aria-label="有新版本"）
        const dot = document.querySelector('[data-name="conversation-sidebar-menu-toggle-button"] [aria-label="有新版本"]')
        expect(dot).not.toBeNull()
    })

    it('契约：panelGeometry import 自 ProjectGroupDrawer（几何常量同源）', () => {
        // 通过时序常量反查同源：hover 120ms 与关闭 200ms 的常量值须与 ProjectGroupDrawer 一致
        expect(PANEL_OPEN_DELAY_MS).toBe(120)
        expect(PANEL_CLOSE_GRACE_MS).toBe(200)
    })

    /**
     * T31: 折叠态点击 collapsed-item 直接弹二级面板，不展开侧栏。
     * 修复点：SidebarGearMenu 从 `{!leftCollapsed && ...}` 分支移出、在 motion.div 内独立挂载；
     * 否则折叠态下 panelPortal 永远不会创建。
     */
    it('T31: 折叠态点击 collapsed-item 直接弹二级面板，不展开侧栏', () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        const collapsedItem = document.querySelector('[data-name="collapsed-item"]')
        expect(collapsedItem, '折叠态必须渲染 collapsed-item 按钮').not.toBeNull()

        fireEvent.click(collapsedItem!)

        // 二级面板出现且带 data-panel-node-id
        const panel = document.querySelector('[data-name="sidebar-gear-secondary-panel"][data-panel-node-id]')
        expect(panel, '折叠态点击后二级面板应出现').not.toBeNull()

        // 侧栏保持折叠（不展开）
        expect(useSidebarStore.getState().leftCollapsed, '折叠态点击不应展开侧栏').toBe(true)
    })

    /**
     * T32: 折叠态外部点击关闭二级面板。
     * 修复点：click-outside 守卫从 `if (!isOpen) return` 改为 `if (!isOpen && !panelNodeId.anchor) return`，
     * 折叠态下 isOpen=false 但 anchor 非空时 listener 仍挂载，否则外部点击无法关闭面板。
     */
    it('T32: 折叠态外部点击关闭二级面板', () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        fireEvent.click(document.querySelector('[data-name="collapsed-item"]')!)
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]'), '面板应已打开').not.toBeNull()

        // 外部点击（mousedown 冒泡到 document listener）
        fireEvent.mouseDown(document.body)

        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]'), '外部点击后面板应消失').toBeNull()
        expect(useSidebarStore.getState().leftCollapsed, '侧栏仍应折叠').toBe(true)
    })

    /**
     * T33: 折叠态 Esc 关闭二级面板。
     * 修复点：Esc 守卫同步放开（同 T32 的逻辑）。
     */
    it('T33: 折叠态 Esc 关闭二级面板', () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        fireEvent.click(document.querySelector('[data-name="collapsed-item"]')!)
        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]'), '面板应已打开').not.toBeNull()

        fireEvent.keyDown(document, {key: 'Escape'})

        expect(document.querySelector('[data-name="sidebar-gear-secondary-panel"]'), 'Esc 后面板应消失').toBeNull()
        expect(useSidebarStore.getState().leftCollapsed, '侧栏仍应折叠').toBe(true)
    })
})

/**
 * 折叠态一级抽屉（Alt）定位：齿轮按钮在展开态 footer，折叠态下 anchorRef.current=null，
 * 原实现回退 `{left:0, top:4}` → 抽屉落在窗口左上角（技术债）。
 * 新口径：锚定折叠栏底部的「展开侧边栏」按钮 —— 左缘贴其右侧 8px、底边与按钮底边对齐、
 * 向上展开（左下角形态，与二级面板「贴锚点右侧」的左缘口径一致）。
 */
describe('折叠态一级抽屉定位（Alt 打开，锚定底部展开按钮）', () => {
    it('抽屉贴展开按钮右侧 8px、底边对齐按钮底边（不再落左上角）', () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        const expandBtn = document.querySelector('[data-name="conversation-sidebar-expand-button"]') as HTMLElement
        expect(expandBtn, '折叠态应渲染底部展开按钮').not.toBeNull()
        // jsdom 视口高 768：按钮底边距窗口底 16px（真实布局里由 mb-[8px] 决定）
        vi.spyOn(expandBtn, 'getBoundingClientRect').mockReturnValue({
            top: 726, right: 44, left: 18, bottom: 752, width: 26, height: 26,
            x: 18, y: 726, toJSON: () => ({}),
        } as DOMRect)

        fireEvent(window, new CustomEvent('hclaw:toggle-gear-menu'))

        const drawer = document.querySelector('[data-name="sidebar-gear-primary-drawer"]') as HTMLElement
        expect(drawer, 'Alt 应打开一级抽屉').not.toBeNull()
        expect(parseFloat(drawer.style.left)).toBe(52) // 按钮右缘 44 + 8
        expect(parseFloat(drawer.style.bottom)).toBe(16) // 窗口高 768 − 按钮底边 752
        expect(drawer.style.top).toBe('') // 向上展开：不得残留 top 定位
    })
})

/**
 * 二级面板几何：对齐基准必须是「实际渲染高度」。
 *
 * 缺陷（fe4901b 引入）：上弹分支用 Math.max(内容高度, MIN_PANEL_HEIGHT=120) 做对齐基准，
 * 但面板无 minHeight、实际高度 = 内容高度（既定口径：短列表不撑白）。
 * 短列表（2 项 = 66px）上弹时按 120 预留 → 面板底边比锚点顶边高 54px 浮空
 * （真机：折叠态「运维管理」面板悬在图标上方，不跟随一级图标）。
 */
describe('二级面板几何：对齐基准 = 内容实际高度（不按 MIN_PANEL_HEIGHT 预留）', () => {
    /** 内容自然高度（与实现同源的估算公式） */
    const contentHeight = (items: number) => items * GEAR_PANEL_ITEM_ROW_HEIGHT + GEAR_PANEL_CHROME_HEIGHT

    it('短列表 + 锚点贴近视口底部：面板底边贴锚点顶边（不浮空）', () => {
        const anchor = {top: 700, right: 44}
        const h = contentHeight(2) // 66 < MIN_PANEL_HEIGHT(120)
        const g = computeSidebarPanelGeometry(undefined, anchor, h)
        // 面板实际渲染高度 = 内容高度 → 上弹后底边必须与锚点顶边重合
        expect(g.top + h).toBe(anchor.top)
        // maxHeight 仍保留下限（长列表兜底），但不得参与对齐基准
        expect(g.maxHeight).toBeGreaterThanOrEqual(h)
    })

    it('下方空间足够放下内容高度：不得误判为上弹', () => {
        const anchor = {top: 680, right: 44}
        const h = contentHeight(2) // 66
        // innerHeight(768) - 680 - 12 = 76 ≥ 66 → 下弹，top 与锚点顶边对齐
        const g = computeSidebarPanelGeometry(undefined, anchor, h)
        expect(g.top).toBe(anchor.top)
    })

    it('长列表（6 项）下方空间不足：上弹到底边贴锚点顶边', () => {
        const anchor = {top: 700, right: 44}
        const h = contentHeight(6) // 178
        const g = computeSidebarPanelGeometry(undefined, anchor, h)
        expect(g.top + h).toBe(anchor.top)
    })

    it('顶部锚点：下弹，top 与锚点顶边对齐', () => {
        const g = computeSidebarPanelGeometry(undefined, {top: 40, right: 44}, contentHeight(2))
        expect(g.top).toBe(40)
    })

    it('展开态：左缘贴抽屉右缘 + 8px', () => {
        const g = computeSidebarPanelGeometry(500, {top: 40, right: 300}, contentHeight(3))
        expect(g.left).toBe(508)
    })

    it('折叠态「运维管理」：面板与 shadow zone 都贴在图标顶边（不浮空）', () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        const item = document.querySelector('[data-name="collapsed-item"][title="运维管理"]') as HTMLElement
        expect(item, '折叠态应渲染「运维管理」一级图标').not.toBeNull()
        const anchorTop = 700
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
            top: anchorTop, right: 44, left: 12, bottom: anchorTop + 28, width: 32, height: 28,
            x: 12, y: anchorTop, toJSON: () => ({}),
        } as DOMRect)

        fireEvent.click(item)

        const opsNode = SIDEBAR_MENU_NODES.find((n) => n.kind === 'group' && n.group === '运维管理')
        if (!opsNode || opsNode.kind !== 'group') throw new Error('菜单真源缺少「运维管理」group 节点')
        const h = contentHeight(opsNode.items.length)

        const panel = document.querySelector('[data-name="sidebar-gear-secondary-panel"]') as HTMLElement
        // 面板底边 = 锚点顶边（既不浮空，也不越过图标）
        expect(parseFloat(panel.style.top) + h).toBe(anchorTop)
        // shadow zone 起点 = 面板实际底边，不再多铺 MIN_PANEL_HEIGHT 差额的幽灵吞点击区
        const shadow = document.querySelector('[data-name="sidebar-gear-panel-shadow-zone"]') as HTMLElement
        expect(parseFloat(shadow.style.top)).toBe(anchorTop)
    })

    it('折叠态 preferAbove：上方空间充足时一律上弹（不再按下方空间下弹）', () => {
        const anchor = {top: 300, right: 44}
        const h = contentHeight(2)
        // 默认规则下 spaceBelow(456) ≥ h → 会下弹；折叠态要求整列图标一致向上展开
        const g = computeSidebarPanelGeometry(undefined, anchor, h, true)
        expect(g.top + h).toBe(anchor.top)
    })

    it('折叠态 preferAbove：上方空间不足时回退下弹（不贴顶压住图标）', () => {
        const anchor = {top: 40, right: 44}
        const h = contentHeight(6) // 178 > 40 - 12 → 上方放不下
        const g = computeSidebarPanelGeometry(undefined, anchor, h, true)
        // 下方空间 716 ≥ 178 → 回退下弹，顶边与锚点顶边对齐
        expect(g.top).toBe(anchor.top)
    })

    it('折叠态「模型配置」（上方空间充足）：面板上弹，底边贴图标顶边', () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        const item = document.querySelector('[data-name="collapsed-item"][title="模型配置"]') as HTMLElement
        expect(item, '折叠态应渲染「模型配置」一级图标').not.toBeNull()
        const anchorTop = 300
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
            top: anchorTop, right: 44, left: 12, bottom: anchorTop + 28, width: 32, height: 28,
            x: 12, y: anchorTop, toJSON: () => ({}),
        } as DOMRect)

        fireEvent.click(item)

        const groupNode = SIDEBAR_MENU_NODES.find((n) => n.kind === 'group' && n.group === '模型配置')
        if (!groupNode || groupNode.kind !== 'group') throw new Error('菜单真源缺少「模型配置」group 节点')
        const h = contentHeight(groupNode.items.length)

        const panel = document.querySelector('[data-name="sidebar-gear-secondary-panel"]') as HTMLElement
        expect(parseFloat(panel.style.top) + h).toBe(anchorTop)
    })
})

/**
 * V1 回归：三条关闭路径（Alt toggle / Esc / click-outside）必须先清 pending open timer。
 *
 * 缺陷：hover group 时 open timer 已挂起（尚未到 120ms），若此时关闭抽屉只清 panelNodeId 状态，
 * timer 到期后仍会 setPanelNodeId({node})，于是「重新展开抽屉」时残留 node 命中
 * panelAnchorMap → 面板自动复现（用户没再 hover 却看到面板）。
 * 判别点：关闭后推进越过 PANEL_OPEN_DELAY_MS，且在**重新展开抽屉后**仍无面板。
 */
describe('V1 回归：关闭路径清理 pending open timer', () => {
    /** 面板是否存在（每次实时查询，避免拿到旧引用） */
    const panelExists = () => document.querySelector('[data-name="sidebar-gear-secondary-panel"]') !== null

    it('T34: hover 挂起中 Esc 关闭 → 越过 open delay + 重新展开抽屉均无面板复现', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()

        // t=0：hover group → open timer 挂起（未到期）
        fireEvent.mouseEnter(groupNode(1))
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS - 1)
        expect(panelExists(), '未到期前不应打开面板').toBe(false)

        // 到期前 Esc 关闭（必须清掉 pending open timer）
        fireEvent(document, new KeyboardEvent('keydown', {key: 'Escape'}))
        await act(async () => { await Promise.resolve() })
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).toBeNull()

        // 越过 open delay：若 timer 残留，会 setPanelNodeId → 抽屉重开后复现
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS)
        await act(async () => {})
        expect(panelExists(), '残留 open timer 不得在关闭后把面板拉起').toBe(false)

        // 重新展开抽屉（走鼠标开合按钮，不经 Alt 的显式清空路径）：
        // 若 panelNodeId 残留，展开后几何 effect 会命中 panelAnchorMap → 面板复现
        openGear()
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).not.toBeNull()
        expect(panelExists(), '重新展开抽屉后不得有残留面板复现').toBe(false)
    })

    it('T35: hover 挂起中 Alt 关闭 → 越过 open delay 无面板复现', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()

        fireEvent.mouseEnter(groupNode(0))
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS - 1)

        // Alt（hclaw:toggle-gear-menu）关闭抽屉
        fireEvent(window, new CustomEvent('hclaw:toggle-gear-menu'))
        await act(async () => {})
        expect(document.querySelector('[data-name="sidebar-gear-primary-drawer"]')).toBeNull()

        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS)
        await act(async () => {})
        expect(panelExists(), 'Alt 关闭后残留 open timer 不得拉起面板').toBe(false)

        // 重新展开（鼠标开合按钮）→ 仍无面板
        openGear()
        await act(async () => {})
        expect(panelExists()).toBe(false)
    })
})

/**
 * P0 回归：侧边栏面板「跨目标切换」。
 *
 * 用户主路径：连续在两个一级目标（折叠态图标 / 展开态组头）间切换时，
 * 二级面板必须切到新目标 —— node id、渲染内容、几何（top/left）三者全部跟随，
 * 且全程只允许存在 0/1 个面板实例（不得残留旧面板、不得 A/B 内容错配）。
 *
 * 断言口径（判别力）：一律锁「目标 B 的 node id + B 的 items 集合 + B 锚点算出的几何」，
 * 只断言「面板存在」会让 A 残留的旧面板也变绿。
 */

/** 折叠态一级图标（按 group 名定位） */
function collapsedItem(group: string): HTMLElement {
    const el = document.querySelector(`[data-name="collapsed-item"][title="${group}"]`) as HTMLElement | null
    expect(el, `折叠态应渲染「${group}」一级图标`).not.toBeNull()
    return el!
}

/** 给元素挂固定 rect（jsdom 无布局，几何断言全靠它） */
function mockAnchorRect(el: HTMLElement, rect: {top: number, right: number}): void {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        top: rect.top, right: rect.right, left: 12, bottom: rect.top + 28,
        width: 32, height: 28, x: 12, y: rect.top, toJSON: () => ({}),
    } as DOMRect)
}

/** 菜单真源：某 group 的 item type 集合（排序，便于与面板渲染结果对比） */
function itemTypesOf(group: string): string[] {
    const node = SIDEBAR_MENU_NODES.find((n) => n.kind === 'group' && n.group === group)
    if (!node || node.kind !== 'group') throw new Error(`菜单真源缺少 group: ${group}`)
    return node.items.map((i) => i.type ?? '').sort()
}

/** 面板内容自然高度（与实现同源：items 数 × 行高 + chrome，禁止硬编码） */
function panelContentHeightOf(group: string): number {
    const node = SIDEBAR_MENU_NODES.find((n) => n.kind === 'group' && n.group === group)
    if (!node || node.kind !== 'group') throw new Error(`菜单真源缺少 group: ${group}`)
    return node.items.length * GEAR_PANEL_ITEM_ROW_HEIGHT + GEAR_PANEL_CHROME_HEIGHT
}

/** 当前二级面板（不存在 → null） */
function secondaryPanel(): HTMLElement | null {
    return document.querySelector('[data-name="sidebar-gear-secondary-panel"]') as HTMLElement | null
}

/** 面板实例数（恒应为 0/1；出现 2 即残留旧面板） */
function panelCount(): number {
    return document.querySelectorAll('[data-name="sidebar-gear-secondary-panel"]').length
}

/** 当前面板的 data-panel-node-id（无面板 → null） */
function currentPanelNodeId(): string | null {
    return secondaryPanel()?.getAttribute('data-panel-node-id') ?? null
}

/** 当前面板渲染的二级项 type 集合（排序） */
function currentPanelItemTypes(): string[] {
    const panel = secondaryPanel()
    if (!panel) return []
    return Array.from(panel.querySelectorAll('[data-name="sidebar-gear-secondary-item"]'))
        .map((el) => el.getAttribute('data-item-type') ?? '')
        .sort()
}

describe('侧边栏面板跨目标切换（P0 回归）', () => {
    it('T36: 折叠态点图标 A → 点图标 B —— node/items/几何 全部切到 B', async () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        const itemA = collapsedItem('模型配置') // 2 项
        const itemB = collapsedItem('能力中心') // 6 项
        // 两图标 rect 不同（top 300 vs 120、right 44 vs 60）→ 几何必须分别跟随
        mockAnchorRect(itemA, {top: 300, right: 44})
        mockAnchorRect(itemB, {top: 120, right: 60})

        // 打开 A
        fireEvent.click(itemA)
        await act(async () => {})
        expect(currentPanelNodeId(), '点击 A 后应锚定 A').toBe('group:模型配置')
        expect(currentPanelItemTypes(), '内容 = A 的 items').toEqual(itemTypesOf('模型配置'))
        const geomA = {top: parseFloat(secondaryPanel()!.style.top), left: parseFloat(secondaryPanel()!.style.left)}

        // 切到 B
        fireEvent.click(itemB)
        await act(async () => {})
        expect(panelCount(), '任一时刻只允许 1 个面板').toBe(1)
        expect(currentPanelNodeId(), '切换后 node 必须是 B（A 残留即红）').toBe('group:能力中心')
        expect(currentPanelItemTypes(), '内容必须是 B 的 items（A 残留即红）').toEqual(itemTypesOf('能力中心'))
        const geomB = {top: parseFloat(secondaryPanel()!.style.top), left: parseFloat(secondaryPanel()!.style.left)}

        // 几何按 B 的锚点重算：A 上弹（preferAbove），B 上方放不下 → 回退下弹贴锚点顶边
        expect(geomA.top, 'A：上弹底边贴图标顶边').toBe(300 - panelContentHeightOf('模型配置'))
        expect(geomB.top, 'B：下弹顶边贴图标顶边').toBe(120)
        expect(geomA.left, 'A：左缘 = 图标右缘 44 + 8').toBe(52)
        expect(geomB.left, 'B：左缘 = 图标右缘 60 + 8').toBe(68)
        // 判别点：几何确实随锚点变化（若几何不重算/沿用 A，两条 equal 会失败）
        expect(geomB.top).not.toBe(geomA.top)
        expect(geomB.left).not.toBe(geomA.left)
    })

    it('T37: 展开态 hover A(120ms) → hover B(120ms) —— 切到 B，全程单面板', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()

        const nodeA = groupNode(0) // 模型配置
        const nodeB = groupNode(1) // 能力中心
        // 组头 rect 不同 → panel top 必须跟随（展开态左缘统一贴抽屉右缘，差异落在 top）
        mockAnchorRect(nodeA, {top: 40, right: 300})
        mockAnchorRect(nodeB, {top: 200, right: 300})

        fireEvent.mouseEnter(nodeA)
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS)
        await act(async () => {})
        expect(currentPanelNodeId()).toBe('group:模型配置')
        expect(parseFloat(secondaryPanel()!.style.top)).toBe(40)

        // hover 到 B：open timer 挂起 120ms 后切换
        fireEvent.mouseEnter(nodeB)
        // 切换窗口内：仍是 A 面板，且不得出现第二个面板
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS - 1)
        await act(async () => {})
        expect(panelCount(), '切换窗口内不得出现两个面板').toBe(1)
        expect(currentPanelNodeId(), '未到期前仍是 A').toBe('group:模型配置')

        vi.advanceTimersByTime(1)
        await act(async () => {})
        expect(panelCount(), '切换完成后仍只有一个面板').toBe(1)
        expect(currentPanelNodeId(), 'node 必须切到 B').toBe('group:能力中心')
        expect(currentPanelItemTypes(), '内容必须切到 B 的 items').toEqual(itemTypesOf('能力中心'))
        expect(parseFloat(secondaryPanel()!.style.top), '几何必须切到 B 的锚点（40 → 200）').toBe(200)
    })

    it('T38: 展开态 hover A 开面板后重入 A —— cancelClosePanel 生效，面板保持 A 不闪断', async () => {
        vi.useFakeTimers()
        render(<ConversationSidebar/>)
        openGear()

        const nodeA = groupNode(0)
        mockAnchorRect(nodeA, {top: 40, right: 300})

        fireEvent.mouseEnter(nodeA)
        vi.advanceTimersByTime(PANEL_OPEN_DELAY_MS)
        await act(async () => {})
        expect(currentPanelNodeId()).toBe('group:模型配置')

        // 离开 A → close grace(200ms) 挂起
        fireEvent.mouseLeave(nodeA)
        vi.advanceTimersByTime(PANEL_CLOSE_GRACE_MS - 50)
        await act(async () => {})
        expect(panelCount(), 'grace 未到期面板仍在').toBe(1)

        // 重入同一 group：走 cancelClosePanel() + return 分支（同 node 不重开、不重启计时）
        fireEvent.mouseEnter(nodeA)
        // 判别点：若重入分支漏了 cancelClosePanel，200ms 后 close timer 到期 → 面板消失（红）；
        // 若重入时误调 scheduleOpenPanel，也只是重设同一 node，但计数/几何不应变化。
        vi.advanceTimersByTime(1000)
        await act(async () => {})
        expect(panelCount(), '重入后 close 计时必须被取消（不得闪断）').toBe(1)
        expect(currentPanelNodeId(), '面板必须仍是 A').toBe('group:模型配置')
        expect(currentPanelItemTypes(), '内容必须仍是 A 的 items').toEqual(itemTypesOf('模型配置'))
        expect(parseFloat(secondaryPanel()!.style.top), '几何保持 A 的锚点').toBe(40)

        // 状态机仍健康：真正离开后 grace 到期仍能关闭（证明重入没留下永不关闭的状态）
        fireEvent.mouseLeave(nodeA)
        vi.advanceTimersByTime(PANEL_CLOSE_GRACE_MS)
        await act(async () => {})
        expect(panelCount(), '再次离开后应正常关闭').toBe(0)
    })

    it('T39: 折叠态 A → B → Esc 关闭 → 重开 A —— 无残留面板、无 A/B 内容错配', async () => {
        useSidebarStore.setState({leftCollapsed: true})
        render(<ConversationSidebar/>)

        const itemA = collapsedItem('模型配置')
        const itemB = collapsedItem('能力中心')
        mockAnchorRect(itemA, {top: 300, right: 44})
        mockAnchorRect(itemB, {top: 120, right: 60})

        // 开 A → 切 B
        fireEvent.click(itemA)
        await act(async () => {})
        expect(currentPanelNodeId()).toBe('group:模型配置')

        fireEvent.click(itemB)
        await act(async () => {})
        expect(currentPanelNodeId()).toBe('group:能力中心')
        expect(currentPanelItemTypes()).toEqual(itemTypesOf('能力中心'))

        // Esc 关闭
        fireEvent.keyDown(document, {key: 'Escape'})
        await act(async () => {})
        expect(panelCount(), 'Esc 后面板必须彻底消失（无残留）').toBe(0)

        // 重新打开 A：不得出现两个面板，不得残留 B 的内容/几何
        fireEvent.click(itemA)
        await act(async () => {})
        expect(panelCount(), '重开后只允许 1 个面板').toBe(1)
        expect(currentPanelNodeId(), '重开后必须是 A').toBe('group:模型配置')
        expect(currentPanelItemTypes(), '重开后内容必须是 A 的 items').toEqual(itemTypesOf('模型配置'))
        expect(currentPanelItemTypes(), 'B 独有项（skills）不得残留').not.toContain('skills')
        expect(parseFloat(secondaryPanel()!.style.top), '几何按 A 锚点重算').toBe(300 - panelContentHeightOf('模型配置'))
        expect(parseFloat(secondaryPanel()!.style.left), '左缘按 A 锚点重算').toBe(52)
    })
})
