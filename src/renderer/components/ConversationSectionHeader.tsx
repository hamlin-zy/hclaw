import type {ConversationSection} from '../lib/conversationSections'
import {UNASSIGNED_WORKSPACE_KEY} from '../lib/workspacePath'

/**
 * 项目段段头（spec §7.3，变体 A）。
 *
 * 三操作分工：chevron = 折叠本段（不动 viewScope）；文件夹 = 打开项目管理窗口；
 * 「+」= 在该项目新建会话（停留当前视图）。单项目视图不渲染 chevron 与「+」
 * （新建仍用顶部大按钮），但 PM 入口保留（项目 > 项目组的语义层级）。
 *
 * 视觉约束（不得加码）：段头轻量 —— 小字 + 图标 + 分支徽章；不做卡片；
 * 展开态不显示会话计数，仅折叠态显示「N 条」。
 */
export function ConversationSectionHeader({section, singleProject, onToggleCollapsed, onOpenProjectManager, onNewConversation}: {
    section: ConversationSection
    singleProject: boolean
    onToggleCollapsed: () => void
    onOpenProjectManager: () => void
    onNewConversation: () => void
}) {
    const {projectPath, projectName, gitBranch, collapsed, count} = section
    // 「未归属」虚拟段：没有工作目录 → 不允许新建会话，也没有项目管理/分支可言，
    // 隐藏段头操作位（会话行的右键菜单等操作不受影响）。
    const isUnassigned = projectPath === UNASSIGNED_WORKSPACE_KEY
    const iconButtonClass = 'flex items-center justify-center w-4 h-4 shrink-0 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors'

    return (
        <div
            data-name="conversation-section-header"
            data-project-path={projectPath}
            className="flex items-center gap-1 px-2 pt-1 pb-0.5"
        >
            {!singleProject && (
                <button
                    onClick={onToggleCollapsed}
                    aria-label={collapsed ? `展开 ${projectName}` : `折叠 ${projectName}`}
                    aria-expanded={!collapsed}
                    data-name="section-collapse-toggle"
                    className={iconButtonClass}
                >
                    <svg
                        className={`w-3 h-3 transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`}
                        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"
                    >
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </button>
            )}

            {/* 项目名：唯一弹性收缩项（flex-1 + min-w-0），超长省略，
                保证右侧 shrink-0 的分支徽章/计数/按钮不被挤出列表。
                非单项目视图时单击 = 折叠/展开本段（与 chevron 同口径，不切视图）。 */}
            {!singleProject ? (
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    data-name="section-project-name"
                    title={projectPath}
                    className="flex-1 min-w-0 truncate cursor-pointer text-left text-[13px] font-semibold text-[var(--text-primary)] hover:opacity-80 transition-opacity"
                >
                    {projectName}
                </button>
            ) : (
                <span
                    data-name="section-project-name"
                    title={projectPath}
                    className="flex-1 min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]"
                >
                    {projectName}
                </span>
            )}

            {collapsed && (
                <span data-name="section-count" className="shrink-0 text-[10px] text-[var(--text-secondary)] opacity-70">
                    {count} 条
                </span>
            )}

            {/* 分支徽章：可收缩（样式口径沿用 GitBranchBadge，line 638） */}
            {gitBranch && (
                <span
                    data-name="section-branch-badge"
                    title={gitBranch}
                    className="inline-flex items-center gap-0.5 flex-initial max-w-[130px] min-w-[calc(5ch+26px)] rounded-full bg-[var(--chip-bg)] border border-[var(--chip-border)] px-1.5 py-px text-[11px] font-medium text-gray-500 dark:text-gray-400 overflow-hidden"
                >
                    <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" aria-hidden="true">
                        <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/>
                        <path d="M6 9v6M18 9a9 9 0 01-9 9"/>
                    </svg>
                    <span className="truncate">{gitBranch}</span>
                </span>
            )}

            <div className="ml-auto flex items-center gap-0.5 shrink-0">
                {!isUnassigned && (
                    <button
                        onClick={onOpenProjectManager}
                        aria-label="打开项目管理窗口"
                        title="打开项目管理窗口"
                        data-name="section-pm-button"
                        className={iconButtonClass}
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                        </svg>
                    </button>
                )}
                {!singleProject && !isUnassigned && (
                    <button
                        onClick={onNewConversation}
                        aria-label="在该项目新建会话"
                        title="在该项目新建会话"
                        data-name="section-new-conversation"
                        className={iconButtonClass}
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                    </button>
                )}
            </div>
        </div>
    )
}
