import {useEffect} from 'react'
import {useSidebarStore} from '../stores/sidebarStore'
import {useThemeStore} from '../stores/themeStore'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'
import {useMenuBarStore} from '../stores/menuBarStore'

/**
 * 集中管理所有系统内快捷键（非全局快捷键）
 *
 * 注意事项：
 * 1. 只在 App.tsx 中调用一次
 * 2. Electron 默认菜单的加速器会在主进程拦截按键事件，
 *    自定义菜单（main/menu.ts）已移除所有冲突的默认加速器
 * 3. 组件级快捷键（如 InputArea 的 Enter 发送）不受影响
 */
export function useGlobalHotkeys() {
    useEffect(() => {
        // 纯 Alt 快捷键检测：按住 Alt 期间若按过任何其他键（含 Ctrl/Shift/Meta），
        // 则视为组合键（如 Alt+Tab、Alt+数字），keyup 时不触发
        let altUsed = false
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Alt') {
                // 单独按 Alt → 切换侧边栏左下角功能菜单（三横线按钮，由 SidebarGearMenu 监听）
                if (!altUsed && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
                    window.dispatchEvent(new CustomEvent('hclaw:toggle-gear-menu'))
                }
                // 只在松开 Alt 时重置标志：组合键（如 Alt+↑）中方向键的 keyup 先于 Alt 的 keyup，
                // 若在任意 keyup 重置，会把组合键标志提前清零，导致松开 Alt 被误判为单独按 Alt
                altUsed = false
            }
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            const ctrl = e.ctrlKey || e.metaKey
            const shift = e.shiftKey
            const alt = e.altKey
            const key = e.key.toLowerCase()

            if (alt && key !== 'alt') altUsed = true
            if (ctrl || shift || e.metaKey) altUsed = true

            // Ctrl+N → 新建会话
            if (ctrl && !shift && key === 'n') {
                e.preventDefault()
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
                return
            }

            // Alt+↑ → 上一个会话 / Alt+↓ → 下一个会话
            // 只在顶级会话（独立会话 + 父会话）之间切换，排除子会话；
            // 当前激活的是子会话时，先切回其父会话。
            if (alt && !shift && (key === 'arrowup' || key === 'arrowdown')) {
                e.preventDefault()
                const convStore = useConversationStore.getState()
                const allConvs = convStore.getFilteredConversations()
                const currentId = convStore.activeConversationId
                if (!currentId) return

                // 当前激活的是子会话 → 先切回其父会话
                const activeConv = allConvs.find(c => c.id === currentId)
                if (activeConv?.parentConvId) {
                    convStore.setActiveConversation(activeConv.parentConvId)
                    return
                }

                // 仅遍历顶级会话，排除子会话
                const convs = allConvs.filter(c => !c.parentConvId)
                if (convs.length <= 1) return
                const idx = convs.findIndex(c => c.id === currentId)
                const direction = key === 'arrowup' ? -1 : 1
                const target = idx + direction
                if (target >= 0 && target < convs.length) {
                    convStore.setActiveConversation(convs[target].id)
                }
                return
            }

            // Ctrl+B → 切换左侧栏
            if (ctrl && !shift && key === 'b') {
                e.preventDefault()
                useSidebarStore.getState().toggleLeft()
                return
            }

            // Ctrl+Shift+B → 切换右侧备忘录面板
            if (ctrl && shift && key === 'b') {
                e.preventDefault()
                useSidebarStore.getState().toggleRight()
                return
            }

            // Ctrl+Shift+T → 切换主题
            if (ctrl && shift && key === 't') {
                e.preventDefault()
                useThemeStore.getState().toggleTheme()
                return
            }

            // Esc → 中断 Agent（需有活跃会话，且无对话框/弹窗打开时）
            if (key === 'escape') {
                const activeDialog = useMenuBarStore.getState().activeDialog
                // 有对话框打开时，Esc 交给对话框自身处理（关闭对话框）
                if (activeDialog) return
                // 有其他浮动弹窗打开时（如工具弹窗、聚合卡片弹窗、命令补全等），
                // Esc 交给弹窗自身处理，不终止 Agent
                const agentState = useAgentStore.getState()
                if (agentState.toolPopupData || agentState.combinedPopupData || agentState.pendingPermissionConfirm) return
                const activeId = useConversationStore.getState().activeConversationId
                if (activeId) {
                    e.preventDefault()
                    agentState.abortAgent(activeId)
                }
                return
            }

            // Ctrl+K → 命令选择弹窗
            if (ctrl && key === 'k') {
                e.preventDefault()
                window.dispatchEvent(new CustomEvent('hclaw:toggle-command-palette'))
                return
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        document.addEventListener('keyup', handleKeyUp)
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('keyup', handleKeyUp)
        }
    }, [])
}
