import {useEffect, useId, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'
import type {Task, TaskStatus} from '@shared/types'

// ─── 可见性判定 ──────────────────────────────────────

/** 任务终态集合：批次内全部任务到达终态即视为完成，TodoStrip 隐藏 */
const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'error', 'success'])

// ─── 图标 ────────────────────────────────────────────

/** 表头引导图标（checklist） */
const ChecklistIcon = ({className}: { className?: string }) => (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="6" height="6" rx="1"/>
        <path d="m3 17 2 2 4-4"/>
        <path d="M13 6h8"/>
        <path d="M13 12h8"/>
        <path d="M13 18h8"/>
    </svg>
)

const ChevronUpIcon = ({className}: { className?: string }) => (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="18 15 12 9 6 15"/>
    </svg>
)

/** completed：实心对勾圆 */
const CompletedGlyph = () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
         className="text-[var(--success)]">
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2"/>
        <path d="m4.7 7.2 1.7 1.7 2.9-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
              strokeLinejoin="round"/>
    </svg>
)

/** running：品牌色渐隐圆环，CSS 旋转 */
const RunningGlyph = () => {
    // InputArea 每个会话页各挂载一份，渐变 id 必须唯一
    const gradientId = useId()
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
             className="animate-spin text-[var(--brand-primary)]">
            <defs>
                <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5"
                                gradientUnits="userSpaceOnUse">
                    <stop stopColor="currentColor"/>
                    <stop offset="1" stopColor="currentColor" stopOpacity="0"/>
                </linearGradient>
            </defs>
            <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2"/>
        </svg>
    )
}

/** pending：虚线未开始圆环 */
const PendingGlyph = () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
         className="text-[var(--text-muted)]">
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4"/>
    </svg>
)

/** failed / error / success 异常态：红色叉圆环 */
const FailedGlyph = () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
         className="text-[var(--error)]">
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2"/>
        <path d="m5 5 4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
)

function StatusGlyph({status}: { status: TaskStatus }) {
    switch (status) {
        case 'completed':
            return <CompletedGlyph/>
        case 'running':
            return <RunningGlyph/>
        case 'failed':
        case 'error':
            return <FailedGlyph/>
        case 'pending':
        case 'success':
        default:
            return <PendingGlyph/>
    }
}

// ─── 状态计数标签："·" 连接，零计数省略 ────────────────

function progressLabel(tasks: Task[]): string {
    const done = tasks.filter(t => t.status === 'completed').length
    const active = tasks.filter(t => t.status === 'running').length
    const failed = tasks.filter(t => t.status === 'failed' || t.status === 'error').length
    const pending = tasks.length - done - active - failed
    const parts: string[] = []
    if (done > 0) parts.push(`${done} 已完成`)
    if (active > 0) parts.push(`${active} 进行中`)
    if (pending > 0) parts.push(`${pending} 待处理`)
    if (failed > 0) parts.push(`${failed} 失败`)
    // U+2002 en space：HTML 会折叠连续 ASCII 空格，分隔符需要宽空格字面量
    return parts.join('\u2002·\u2002')
}

// ─── 列表项 ──────────────────────────────────────────

function TodoItem({task}: { task: Task }) {
    const isCompleted = task.status === 'completed'
    return (
        <li
            data-status={task.status}
            title={task.description || task.title}
            className={`flex items-center gap-2.5 min-w-0 text-[13px] leading-5 ${
                isCompleted ? 'text-[var(--text-muted)] line-through' :
                    task.status === 'running' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
            }`}
        >
            <span className="grid place-items-center w-4 h-4 shrink-0" aria-hidden="true">
                <StatusGlyph status={task.status}/>
            </span>
            <span className="min-w-0 truncate">{task.title}</span>
        </li>
    )
}

// ─── TodoStrip 主组件：InputArea 顶部延伸区块 ───────────

/**
 * 待办计划条 — 参考 deepseek-harness ui-conversation TodoPanel 样式。
 * 渲染于 InputArea 卡片内部顶端（附件栏之下、输入区之上）：
 * - 三分支可见性：仅「存在活跃批次（currentBatch.status === 'active'）
 *   且批次内有非终态任务」时显示，否则整块隐藏（返回 null）
 * - 无实时批次态时（应用重启/刷新后），挂载时经 hydrateActiveBatch 从主进程 DB 水合
 * - 默认折叠为一行表头（图标 + 标题 + 各状态计数 + chevron），点击展开滚动列表
 * - 列表 max-height 180px 内部滚动，条目单行省略，悬停经 title 显示完整描述
 */
export default function TodoStrip() {
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const convData = useAgentStore((s) => activeConversationId ? s.convAgentStates[activeConversationId] : undefined)
    const hydrateActiveBatch = useAgentStore((s) => s.hydrateActiveBatch)
    // tasks 即当前批次的全部可见任务（水合/事件均按批次快照写入）
    const tasks = convData?.tasks ?? []
    const currentBatch = convData?.currentBatch
    const [collapsed, setCollapsed] = useState(true)

    // 重启水合：无批次态且无任务时从主进程 DB 拉取活跃批次
    // （已有实时数据则跳过；无活跃批次时查询返回 null，不产生副作用）
    useEffect(() => {
        if (!currentBatch && tasks.length === 0 && activeConversationId) {
            void hydrateActiveBatch(activeConversationId)
        }
    }, [activeConversationId, currentBatch, tasks.length, hydrateActiveBatch])

    const visible = !!currentBatch && currentBatch.status === 'active'
        && tasks.some(t => !TERMINAL_STATUSES.has(t.status))

    if (!visible || tasks.length === 0) return null

    return (
        <div data-name="todo-strip">
            <section aria-label="待办列表" className="px-[18px] py-1.5">
                <button
                    type="button"
                    data-name="todo-strip-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsed(v => !v)}
                    className="flex items-center gap-2.5 w-full h-[30px] p-0 border-none bg-transparent text-left cursor-pointer"
                >
                    <span className="grid place-items-center shrink-0 text-[var(--text-muted)]" aria-hidden="true">
                        <ChecklistIcon/>
                    </span>
                    <span className="shrink-0 text-[13px] leading-6 font-medium text-[var(--text-primary)]">待办列表</span>
                    <span
                        className="flex-1 min-w-0 truncate text-[13px] leading-5 text-[var(--text-muted)] whitespace-nowrap">
                        {progressLabel(tasks)}
                    </span>
                    <span aria-hidden="true"
                          className={`grid place-items-center shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${collapsed ? '' : 'rotate-180'}`}>
                        <ChevronUpIcon/>
                    </span>
                </button>

                {!collapsed && (
                    <ul
                        className="flex flex-col gap-1.5 m-0 py-0.5 pb-2.5 pl-0 list-none max-h-[180px] overflow-y-auto"
                    >
                        <AnimatePresence initial={false}>
                            {tasks.map((task, index) => (
                                <motion.li
                                    key={task.id || index}
                                    initial={{opacity: 0}}
                                    animate={{opacity: 1}}
                                    exit={{opacity: 0}}
                                    transition={{duration: 0.12}}
                                    className="list-none"
                                >
                                    <TodoItem task={task}/>
                                </motion.li>
                            ))}
                        </AnimatePresence>
                    </ul>
                )}
            </section>

            {/* 分隔线：待办条与输入区衔接；折叠态隐藏 */}
            {!collapsed && (
                <div className="h-px bg-[var(--border)] mx-[14px]" aria-hidden="true"/>
            )}
        </div>
    )
}
