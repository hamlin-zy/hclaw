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
        const handleKeyDown = (e: KeyboardEvent) => {
            const ctrl = e.ctrlKey || e.metaKey
            const shift = e.shiftKey
            const alt = e.altKey
            const key = e.key.toLowerCase()

            // Ctrl+N → 新建会话
            if (ctrl && !shift && key === 'n') {
                e.preventDefault()
                const store = useConversationStore.getState()
                if (store.currentWorkspacePath) {
                    store.createConversation().then((newId) => {
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
            if (alt && !shift && (key === 'arrowup' || key === 'arrowdown')) {
                e.preventDefault()
                const convStore = useConversationStore.getState()
                const convs = convStore.getFilteredConversations()
                const currentId = convStore.activeConversationId
                if (convs.length <= 1 || !currentId) return
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

            // Ctrl+Shift+B → 切换右侧栏
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
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [])
}
