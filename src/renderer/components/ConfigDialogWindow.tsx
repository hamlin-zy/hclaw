import {useThemeSync} from '../lib/theme'
import WindowTitleBar from './common/WindowTitleBar'
import LLMConfigDialog from './dialogs/LLMConfigDialog'
import MCPDialog from './dialogs/MCPDialog'
import ModelSchemeDialog from './dialogs/ModelSchemeDialog'
import ToolsDialog from './dialogs/ToolsDialog'
import AgentsDialog from './dialogs/AgentsDialog'
import SkillsDialog from './dialogs/SkillsDialog'
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
import TaskHistoryDialog from './dialogs/TaskHistoryDialog'
import PermissionRulesPanel from './PermissionRulesPanel'
import LlmLogsWindow from './LlmLogsWindow'
import UsageWindow from './usage/UsageWindow'

interface DialogConfig {
    title: string
    Component: React.ComponentType
}

/**
 * 迁移到独立窗口的 dialogType → 组件映射。
 * 阶段 2 试点 3 个高频 Dialog；阶段 3（Task 3A）补全其余 14 种。
 */
const DIALOG_CONFIG: Record<string, DialogConfig> = {
    'permission-rules': {title: '权限规则', Component: PermissionRulesPanel},
    'llm-config': {title: '模型配置', Component: LLMConfigDialog},
    'mcp': {title: 'MCP 服务', Component: MCPDialog},
    'scheme-config': {title: '模型方案', Component: ModelSchemeDialog},
    'tools': {title: '工具管理', Component: ToolsDialog},
    'agents': {title: 'Agents', Component: AgentsDialog},
    'skills': {title: 'Skills', Component: SkillsDialog},
    'plugins': {title: '插件管理', Component: PluginDialog},
    'commands': {title: '命令管理', Component: CommandsDialog},
    'schedules': {title: '定时任务', Component: ScheduleDialog},
    'channels': {title: '渠道管理', Component: ChannelsDialog},
    'prompt-config': {title: '提示词方案', Component: PromptConfigDialog},
    'conversations': {title: '会话管理', Component: ConversationsDialog},
    'settings': {title: '系统设置', Component: SettingsDialog},
    'tool-list': {title: '工具列表预览', Component: ToolListDialog},
    'system-prompt': {title: '系统提示词预览', Component: SystemPromptDialog},
    'about': {title: '关于 HClaw', Component: AboutDialog},
    'llm-logs': {title: 'LLM 调用日志', Component: LlmLogsWindow},
    'usage': {title: '用量统计', Component: UsageWindow},
    // 双作用域共用同一组件（组件内部按 dialogType / taskConvId 区分全量与当前会话视图）
    'task-history': {title: '任务历史', Component: TaskHistoryDialog},
    'task-history-conv': {title: '任务历史', Component: TaskHistoryDialog},
}

export default function ConfigDialogWindow() {
    useThemeSync()
    const dialogType = window.electronAPI?.dialogType ?? ''
    const config = DIALOG_CONFIG[dialogType]

    return (
        <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
            <WindowTitleBar title={config?.title ?? '配置'}/>
            <div className="flex-1 min-h-0 overflow-hidden">
                {config
                    ? <config.Component/>
                    : (
                        <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
                            未知配置类型: {dialogType}
                        </div>
                    )}
            </div>
        </div>
    )
}
