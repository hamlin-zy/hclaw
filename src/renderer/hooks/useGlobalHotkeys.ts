import {useEffect} from 'react'
import {useSidebarStore} from '../stores/sidebarStore'
import {useThemeStore} from '../stores/themeStore'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'
import {useMenuBarStore} from '../stores/menuBarStore'
import {openMemoCreateWindow} from '../stores/memoStore'
import {shortcutManager} from '../services/shortcutManager'

/**
 * 集中管理所有系统内快捷键（非全局快捷键）
 *
 * 注意事项：
 * 1. 只在 App.tsx 中调用一次
 * 2. Electron 默认菜单的加速器会在主进程拦截按键事件，
 *    自定义菜单（main/menu.ts）已移除所有冲突的默认加速器
 * 3. 组件级快捷键（如 InputArea 的 Enter 发送）不受影响
 * 4. 可配置的 action 按键匹配交给 shortcutManager（配置驱动），
 *    本 hook 只注册各 action 的处理逻辑；
 *    Esc 中断与 Alt 单键功能菜单不在配置范围，保持原逻辑。
 */
export function useGlobalHotkeys() {
    useEffect(() => {
        const stop = shortcutManager.startShortcutManager()

        const unsubNew = shortcutManager.on('newSession', () => {
            const store = useConversationStore.getState()
            if (store.currentWorkspacePath) {
                store.createConversation().then(() => {
                    // 创建会话后触发焦点事件，让 InputArea 获取焦点
                    window.dispatchEvent(new CustomEvent('hclaw:focus-input'))
                })
            } else {
                // 无工作空间时弹窗选择目录（由 NewChatButton 处理）
                window.dispatchEvent(new CustomEvent('hclaw:new-conversation'))
            }
        })
        const unsubMemo = shortcutManager.on('newMemo', () => {
            const ws = useConversationStore.getState().currentWorkspacePath
            if (ws) openMemoCreateWindow(ws)
        })
        const unsubPrev = shortcutManager.on('prevSession', () => switchSession(-1))
        const unsubNext = shortcutManager.on('nextSession', () => switchSession(1))
        const unsubLeft = shortcutManager.on('toggleLeftSidebar', () => useSidebarStore.getState().toggleLeft())
        const unsubRight = shortcutManager.on('toggleRightSidebar', () => useSidebarStore.getState().toggleRight())
        const unsubTheme = shortcutManager.on('toggleTheme', () => useThemeStore.getState().toggleTheme())
        const unsubPalette = shortcutManager.on('toggleCommandPalette', () => {
            window.dispatchEvent(new CustomEvent('hclaw:toggle-command-palette'))
        })

        // ── 以下为不在配置范围的原有监听（原样保留） ──

        // Alt+↑/↓ 等组合键会混入 Alt 单键检测，keydown 中需要持续跟踪
        // 纯 Alt 快捷键检测标志：按住 Alt 期间若按过任何其他键（含 Ctrl/Shift/Meta），
        // 则视为组合键（如 Alt+Tab、Alt+数字），keyup 时不触发
        let altUsed = false
        const handleAltTrackingKeyDown = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase()
            if (e.altKey && key !== 'alt') altUsed = true
            if (e.ctrlKey || e.shiftKey || e.metaKey) altUsed = true
        }

        // 单独按 Alt（keyup 时）→ 切换侧边栏左下角功能菜单（三横线按钮，由 SidebarGearMenu 监听）
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Alt') {
                if (!altUsed && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
                    window.dispatchEvent(new CustomEvent('hclaw:toggle-gear-menu'))
                }
                // 只在松开 Alt 时重置标志：组合键（如 Alt+↑）中方向键的 keyup 先于 Alt 的 keyup，
                // 若在任意 keyup 重置，会把组合键标志提前清零，导致松开 Alt 被误判为单独按 Alt
                altUsed = false
            }
        }

        // Esc → 中断 Agent（需有活跃会话，且无对话框/弹窗打开时）
        const handleEscKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            const activeDialog = useMenuBarStore.getState().activeDialog
            // 有对话框打开时，Esc 交给对话框自身处理（关闭对话框）
            if (activeDialog) return
            // 有其他浮动弹窗打开时（如工具弹窗、聚合卡片弹窗、命令补全等），
            // Esc 交给弹窗自身处理，不终止 Agent
            const agentState = useAgentStore.getState()
            if (agentState.toolPopupData || agentState.combinedPopupData || agentState.pendingPermissionConfirm
                || agentState.pendingToolsChangeConfirm) return
            const activeId = useConversationStore.getState().activeConversationId
            if (activeId) {
                e.preventDefault()
                agentState.abortAgent(activeId)
            }
        }

        document.addEventListener('keydown', handleAltTrackingKeyDown)
        document.addEventListener('keyup', handleKeyUp)
        document.addEventListener('keydown', handleEscKeyDown)

        return () => {
            ;[unsubNew, unsubMemo, unsubPrev, unsubNext, unsubLeft, unsubRight, unsubTheme, unsubPalette].forEach(u => u())
            document.removeEventListener('keydown', handleAltTrackingKeyDown)
            document.removeEventListener('keyup', handleKeyUp)
            document.removeEventListener('keydown', handleEscKeyDown)
            stop()
        }
    }, [])
}

/** 会话切换：仅顶级会话；子会话激活时先切回父会话（原 Alt+↑/↓ 逻辑原样迁移） */
function switchSession(direction: -1 | 1): void {
    const convStore = useConversationStore.getState()
    const allConvs = convStore.getFilteredConversations()
    const currentId = convStore.activeConversationId
    if (!currentId) return
    const activeConv = allConvs.find(c => c.id === currentId)
    if (activeConv?.parentConvId) {
        convStore.setActiveConversation(activeConv.parentConvId)
        return
    }
    const convs = allConvs.filter(c => !c.parentConvId)
    if (convs.length <= 1) return
    const idx = convs.findIndex(c => c.id === currentId)
    const target = idx + direction
    if (target >= 0 && target < convs.length) convStore.setActiveConversation(convs[target].id)
}
