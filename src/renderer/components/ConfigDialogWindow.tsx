import {Component, Suspense, lazy, useMemo, type ReactNode} from 'react'
import {useThemeSync} from '../lib/theme'
import WindowTitleBar from './common/WindowTitleBar'
import TooltipPortal from './common/TooltipPortal'
import ConfirmDialog from './ConfirmDialog'
import BrowserShellWindow from './BrowserShellWindow'

interface DialogConfig {
    title: string
    loader: () => Promise<{default: React.ComponentType}>
}

/**
 * 迁移到独立窗口的 dialogType → 组件映射。
 * 阶段 2 试点 3 个高频 Dialog；阶段 3（Task 3A）补全其余 14 种。
 * Task 19：改为动态 import（按需加载），只在窗口打开时拉取对应 chunk。
 */
const DIALOG_CONFIG: Record<string, DialogConfig> = {
    'permission-rules': {title: '权限规则', loader: () => import('./PermissionRulesPanel')},
    'llm-config': {title: '服务商配置', loader: () => import('./dialogs/LLMConfigDialog')},
    'mcp': {title: 'MCP 服务', loader: () => import('./dialogs/MCPDialog')},
    'scheme-config': {title: '模型方案', loader: () => import('./dialogs/ModelSchemeDialog')},
    'tool-manage': {title: '工具管理', loader: () => import('./dialogs/ToolsDialog')},
    'agents': {title: 'Agents', loader: () => import('./dialogs/AgentsDialog')},
    'skills': {title: 'Skills', loader: () => import('./dialogs/SkillsDialog')},
    'plugins': {title: '插件管理', loader: () => import('./dialogs/PluginDialog')},
    'commands': {title: '命令管理', loader: () => import('./dialogs/CommandsDialog')},
    'schedules': {title: '定时任务', loader: () => import('./dialogs/ScheduleDialog')},
    'channels': {title: '渠道管理', loader: () => import('./dialogs/ChannelsDialog')},
    'prompt-scheme': {title: '提示词方案', loader: () => import('./dialogs/PromptConfigDialog')},
    'conversations': {title: '会话管理', loader: () => import('./dialogs/ConversationsDialog')},
    'settings': {title: '系统设置', loader: () => import('./settings/SettingsDialog')},
    'tool-catalog': {title: '工具清单', loader: () => import('./dialogs/ToolListDialog')},
    'system-prompt': {title: '系统提示词预览', loader: () => import('./dialogs/SystemPromptDialog')},
    'about': {title: '关于 HClaw', loader: () => import('./dialogs/AboutDialog')},
    'llm-logs': {title: 'LLM 调用日志', loader: () => import('./LlmLogsWindow')},
    'usage': {title: '用量统计', loader: () => import('./usage/UsageWindow')},
    // 双作用域共用同一组件（组件内部按 dialogType / taskConvId 区分全量与当前会话视图）
    'task-history': {title: '任务历史', loader: () => import('./dialogs/TaskHistoryDialog')},
    'task-history-conv': {title: '任务历史', loader: () => import('./dialogs/TaskHistoryDialog')},
    'memo-edit': {title: '备忘录编辑', loader: () => import('./dialogs/MemoEditDialog')},
    'quick-phrases': {title: '快捷短语', loader: () => import('./dialogs/PhraseDialog')},
    'memory-manager': {title: '记忆管理', loader: () => import('./dialogs/MemoryManagerDialog')},
    'companion-apps': {title: '跟随启动', loader: () => import('./companion/CompanionAppsWindow')},
}

/** 独立窗口支持的 dialogType 集合（供跨层一致性测试与路由校验复用） */
export const DIALOG_CONFIG_KEYS = new Set(Object.keys(DIALOG_CONFIG))

/** 动态 chunk 加载失败兜底：避免窗口停在白屏（Suspense 无法捕获 reject）。 */
export class DialogChunkErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
    state = {failed: false}
    static getDerivedStateFromError() { return {failed: true} }
    render() {
        if (this.state.failed) {
            return (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
                    <span>窗口资源加载失败</span>
                    <button
                        type="button"
                        className="text-xs px-3 py-1.5 rounded bg-[var(--surface-muted)] border border-[var(--border)]"
                        onClick={() => window.location.reload()}
                    >重新加载</button>
                </div>
            )
        }
        return this.props.children
    }
}

export default function ConfigDialogWindow() {
    useThemeSync()
    const dialogType = window.electronAPI?.dialogType ?? ''
    const config = DIALOG_CONFIG[dialogType]
    // 注意：useMemo 必须在 builtin-browser 早退之前（hooks 规则）
    // deps 用 config：取自模块常量 DIALOG_CONFIG，按 dialogType 身份稳定（等价于按 type 记忆）
    const LazyDialog = useMemo(() => (config ? lazy(config.loader) : null), [config])

    // 内置浏览器外壳：标题跟随网站标题，自持 WindowTitleBar，不走下方固定标题包装
    if (dialogType === 'builtin-browser') {
        return <BrowserShellWindow/>
    }

    return (
        <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
            {/* 独立窗口级确认弹窗：日志窗口/用量窗口及各 dialog 的 confirm() 依赖（主窗口由 App.tsx 挂载） */}
            <ConfirmDialog/>
            {/* 独立窗口缺省无主题 tooltip：挂载全局 TooltipPortal 接管弹窗内所有原生 title */}
            <TooltipPortal/>
            <WindowTitleBar title={config?.title ?? '配置'}/>
            <div className="flex-1 min-h-0 overflow-hidden">
                <DialogChunkErrorBoundary>
                    {LazyDialog
                        ? (
                            <Suspense fallback={<div data-testid="dialog-loading-fallback" className="h-full flex items-center justify-center text-sm text-[var(--text-secondary)]">加载中…</div>}>
                                <LazyDialog/>
                            </Suspense>
                        )
                        : (
                            <div className="h-full flex items-center justify-center text-sm text-[var(--text-secondary)]">
                                未知配置类型: {dialogType}
                            </div>
                        )}
                </DialogChunkErrorBoundary>
            </div>
        </div>
    )
}
