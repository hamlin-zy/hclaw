import {useEffect, useState} from 'react'
import {useMenuBarStore} from '../stores/menuBarStore'
import MenuDialog from './MenuDialog'
import LLMConfigDialog from './dialogs/LLMConfigDialog'
import ModelSchemeDialog from './dialogs/ModelSchemeDialog'
import MCPDialog from './dialogs/MCPDialog'
import ToolsDialog from './dialogs/ToolsDialog'
import AgentsDialog from './dialogs/AgentsDialog'
import SkillsDialog from './dialogs/SkillsDialog'
import HooksDialog from './dialogs/HooksDialog'
import PluginDialog from './dialogs/PluginDialog'
import CommandsDialog from './dialogs/CommandsDialog'
import ScheduleDialog from './dialogs/ScheduleDialog'
import ChannelsDialog from './dialogs/ChannelsDialog'
import PromptConfigDialog from './dialogs/PromptConfigDialog'
import ConversationsDialog from './dialogs/ConversationsDialog'
import SettingsDialog from './dialogs/SettingsDialog'
import ToolListDialog from './dialogs/ToolListDialog'
import SystemPromptDialog from './dialogs/SystemPromptDialog'
import AboutDialog from './dialogs/AboutDialog'
import UpdateNoticeDialog from './dialogs/UpdateNoticeDialog'

interface DialogConfig {
    title: string
    Component: React.ComponentType
    /** 面板宽度 -> 居中 Modal 换算规则：统一按现有 initialWidth 或 widthRatio 取合适 maxWidth */
    initialWidth?: number
    widthRatio?: number
    /** 面板最小宽度，默认 420 */
    minWidth?: number
    /** 面板初始高度（不设则默认 85vh） */
    initialHeight?: number
}

const DIALOG_CONFIG: Record<string, DialogConfig> = {
  'llm-config': {title: '模型配置', Component: LLMConfigDialog, initialWidth: 620},
    'scheme-config': {title: '模型方案', Component: ModelSchemeDialog, initialWidth: 770},
  'mcp': { title: 'MCP 服务', Component: MCPDialog, initialWidth: 680 },
  'tools': { title: '工具管理', Component: ToolsDialog, initialWidth: 580 },
  'agents': { title: 'Agents', Component: AgentsDialog, initialWidth: 450 },
  'skills': { title: 'Skills', Component: SkillsDialog, initialWidth: 580 },
  'hooks': { title: 'Hooks', Component: HooksDialog, initialWidth: 520 },
    'plugins': {title: '插件管理', Component: PluginDialog, initialWidth: 480},
    'commands': {title: '命令管理', Component: CommandsDialog, initialWidth: 580},
    'schedules': {title: '定时任务', Component: ScheduleDialog, initialWidth: 680},
    'channels': {title: '渠道管理', Component: ChannelsDialog, initialWidth: 480},
    'prompt-config': {title: '提示词方案', Component: PromptConfigDialog, initialWidth: 720},
    'conversations': {title: '会话管理', Component: ConversationsDialog, initialWidth: 780, minWidth: 370},
    'settings': {title: '系统设置', Component: SettingsDialog, initialWidth: 780},
    'tool-list': {title: '工具列表预览', Component: ToolListDialog, initialWidth: 580},
    'system-prompt': {title: '系统提示词预览', Component: SystemPromptDialog, initialWidth: 680},
    'about': {title: '关于 HClaw', Component: AboutDialog, initialWidth: 400, minWidth: 360, initialHeight: 430},
  'update-notice': {title: '更新通知', Component: UpdateNoticeDialog, initialWidth: 380, minWidth: 340, initialHeight: 360},
}

/** 根据当前视图宽度和配置，计算居中 Modal 的实际最大宽度 */
function calcModalWidth(config: DialogConfig): number {
    const base = config.initialWidth ?? (config.widthRatio ? Math.floor(window.innerWidth * config.widthRatio) : 480)
    const minW = config.minWidth ?? 420
    return Math.max(minW, Math.min(Math.floor(window.innerWidth * 0.9), base))
}

export default function MenuDialogRenderer() {
    const { activeDialog, dialogOrigin, closeDialog } = useMenuBarStore()
    // 用 key 强制 Dialog 组件在 activeDialog 变更时完全重挂载
    const [, setTick] = useState(0)

    const config = activeDialog ? DIALOG_CONFIG[activeDialog] : null

    // 窗口 resize 时重新计算宽度
    const [modalWidth, setModalWidth] = useState(480)
    useEffect(() => {
        if (!config) return
        setModalWidth(calcModalWidth(config))
        const onResize = () => setModalWidth(calcModalWidth(config))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [activeDialog, config])

    // 点击不同按钮切换 Dialog 时，产生一个 side effect 让 AnimatePresence 触发 exit/enter
    useEffect(() => {
        setTick(n => n + 1)
    }, [activeDialog])

    return (
        <MenuDialog
            isOpen={!!config}
            title={config?.title ?? ''}
            onClose={closeDialog}
            origin={dialogOrigin}
            maxWidth={modalWidth}
            minWidth={config?.minWidth ?? 420}
            initialHeight={config?.initialHeight}
            dialogKey={activeDialog ?? undefined}
        >
            {config && <config.Component />}
        </MenuDialog>
    )
}
