import {Briefcase} from 'lucide-react'
import type {ConversationSection} from '../lib/conversationSections'
import {UNASSIGNED_WORKSPACE_KEY} from '../lib/workspacePath'

/**
 * 项目段段头（spec §7.3，变体 A）。
 *
 * 三操作分工：项目图标 = 折叠本段（不动 viewScope，颜色区分展开/折叠态）；
 * 项目管理按钮（文件夹图标）= 打开项目管理窗口；「+」= 在该项目新建会话（停留当前视图）。
 *
 * 视觉约束（不得加码）：段头轻量 —— 小字 + 图标 + 分支徽章；不做卡片；
 * 五列栅格，条数常显（展开态与折叠态均显示「N 条」）。
 * 左缘对齐内容区（pl-0）：段头图标左缘与搜索框/列表内容左缘齐平，不再额外内缩
 * 8px（2026-09-30 用户反馈「项目左侧距卡片左边框太远」）。
 * 折叠入口 = 项目图标 + 项目名（2 处，与旧 chevron + 项目名的两处口径等量）。
 */
export function ConversationSectionHeader({section, onToggleCollapsed, onOpenProjectManager, onNewConversation}: {
    section: ConversationSection
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
            className="grid grid-cols-[16px_minmax(0,1fr)_fit-content(84px)_44px_fit-content(46px)] items-center gap-1.5 pl-0 pr-2 pt-1 pb-0.5"
        >
            {/* 项目图标按钮：既是折叠入口（替代原 chevron），也是展开/折叠态的视觉信号
                —— 展开态灰（--text-muted，与项目名同色系、清晰可辨 = 当前展开可折叠），
                折叠态淡品牌色（--brand-primary 40% + transparent —— 六成透到背景，暗示「已收起」）。
                aria-expanded / aria-label 与原 chevron 口径完全一致（无障碍不变）。
                图标用 Briefcase（公文包）= "一个工作项目"，与段头 PM 按钮的 Folder（单文件夹，
                项目管理窗口本体）以及组视图徽章上的 Folders（多文件夹，多个项目的组）视觉区分。
                用 inline style 指定颜色：Tailwind JIT 对「任意值色值类名内嵌 color-mix」这种
                方括号 + 括号嵌套的写法可能不生成（观察色不生效），inline style 保证渲染路径单一。
                折叠态混色锚 transparent 而非 white：white 只在浅色主题下「退到背景」，
                深色主题下反被提亮成高对比（2026-09-30 用户反馈深色下展开/折叠效果反转）；
                transparent 让折叠态在深浅两套主题下都弱于展开态。 */}
            <button
                onClick={onToggleCollapsed}
                aria-label={collapsed ? `展开 ${projectName}` : `折叠 ${projectName}`}
                aria-expanded={!collapsed}
                title={collapsed ? `展开 ${projectName}` : `折叠 ${projectName}`}
                data-name="section-project-icon"
                className="flex items-center justify-center w-4 h-4 shrink-0 rounded transition-colors hover:bg-[var(--surface-muted)]"
                style={{color: collapsed ? 'color-mix(in srgb, var(--brand-primary) 40%, transparent)' : 'var(--text-muted)'}}
            >
                <Briefcase className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true"/>
            </button>

            {/* 项目名：唯一弹性收缩项（flex-1 + min-w-0），超长省略，
                保证右侧 shrink-0 的分支徽章/计数/按钮不被挤出列表。
                非单项目视图时单击 = 折叠/展开本段（与 chevron 同口径，不切视图）。 */}
            <button
                type="button"
                onClick={onToggleCollapsed}
                data-name="section-project-name"
                title={projectPath}
                className="min-w-0 truncate cursor-pointer text-left text-[13px] font-semibold text-[var(--text-secondary)] hover:opacity-80 transition-opacity"
            >
                {projectName}
            </button>

            {/* 分支徽章：可收缩（样式口径沿用 GitBranchBadge，line 638）；
                无分支时留空占位，保证同构 —— fit-content(84px) 轨道不因无分支而收缩（spec §5.3.1） */}
            {gitBranch ? (
                <span
                    data-name="section-branch-badge"
                    title={gitBranch}
                    className="inline-flex items-center gap-0.5 rounded-full bg-[var(--chip-bg)] border border-[var(--chip-border)] px-1.5 py-px text-[11px] font-medium text-gray-500 dark:text-gray-400 overflow-hidden"
                >
                    <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" aria-hidden="true">
                        <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/>
                        <path d="M6 9v6M18 9a9 9 0 01-9 9"/>
                    </svg>
                    <span className="truncate">{gitBranch}</span>
                </span>
            ) : (
                // 无分支不留 84px 空占位（2026-09-24 用户拍板）：分支列是 fit-content，
                // 空内容即 0 宽，省下的宽度全归项目名 —— 窄侧栏下项目名不再被挤成「rea…」。
                // 代价：各段「N 条」的右缘不再严格对齐（有分支的段会略左移）。
                <span data-name="section-branch-placeholder" aria-hidden="true" className="w-0"/>
            )}

            {/* 条数：紧邻右侧操作列（段头的栅格次序为 chev → 项目名 → 分支 → 条数 → 操作）。
                排在分支之后而非项目名之后：项目名吃掉弹性宽度后，条数才真正贴住项目管理 / 新建会话按钮，
                中间不再隔着一段空的分支占位。 */}
            <span data-name="section-count" className="text-right tabular-nums text-[10px] text-[var(--text-secondary)]">
                {count} 条
            </span>

            <div className="flex items-center gap-0.5 justify-end">
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
                {!isUnassigned && (
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
