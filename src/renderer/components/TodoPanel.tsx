import {useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import type {Task} from '@shared/types'

// ─── 图标组件 ────────────────────────────────────────

const CheckCircle2 = ({className}: { className?: string }) => (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
)

const Circle = ({className}: { className?: string }) => (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
    </svg>
)

const Loader2 = ({className}: { className?: string }) => (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
)

const AlertCircle = ({className}: { className?: string }) => (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
)

const ListTodo = ({className}: { className?: string }) => (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="6" height="6" rx="1"/>
        <path d="m3 17 2 2 4-4"/>
        <path d="M13 6h8"/>
        <path d="M13 12h8"/>
        <path d="M13 18h8"/>
    </svg>
)

// ─── Task Item 组件（带气泡）──────────────────────────

interface TaskItemProps {
    task: Task
}

function TaskItem({task}: TaskItemProps) {
    const [showTooltip, setShowTooltip] = useState(false)
    const [tooltipPosition, setTooltipPosition] = useState<'right' | 'left'>('right')
    const itemRef = useRef<HTMLDivElement>(null)

    const handleMouseEnter = () => {
        // 检测是否靠近右边界，气泡改为向左显示
        if (itemRef.current) {
            const rect = itemRef.current.getBoundingClientRect()
            const viewportWidth = window.innerWidth
            // 如果距离右边界小于 300px，气泡向左
            if (rect.right > viewportWidth - 300) {
                setTooltipPosition('left')
            } else {
                setTooltipPosition('right')
            }
        }
        setShowTooltip(true)
    }

    const handleMouseLeave = () => {
        setShowTooltip(false)
    }

    const getStatusIcon = () => {
        switch (task.status) {
            case 'completed':
                return <CheckCircle2 className="w-4 h-4 text-green-500"/>
            case 'running':
                return <Loader2 className="w-4 h-4 text-[var(--brand-primary)] animate-spin"/>
            case 'pending':
                return <Circle className="w-4 h-4 text-[var(--text-muted)]"/>
            case 'failed':
            case 'error':
                return <AlertCircle className="w-4 h-4 text-red-500"/>
            default:
                return <Circle className="w-4 h-4 text-[var(--text-muted)]"/>
        }
    }

    return (
        <div ref={itemRef} className="relative">
            <div
                className={`flex items-start gap-3 p-2 rounded-lg transition-colors cursor-default ${
                    task.status === 'running'
                        ? 'bg-[var(--brand-primary-transparent)] ring-1 ring-[var(--brand-primary-muted)]'
                        : 'hover:bg-[var(--surface-hover)]'
                }`}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                <div className="mt-0.5 shrink-0">
                    {getStatusIcon()}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                        <p className={`text-sm truncate ${
                            task.status === 'completed' ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-main)]'
                        }`}>
                            {task.title}
                        </p>
                    </div>
                    {task.description && task.status === 'running' && (
                        <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-1 italic">
                            {task.description}
                        </p>
                    )}
                </div>
            </div>

            {/* 气泡显示完整内容 */}
            <AnimatePresence>
                {showTooltip && (
                    <motion.div
                        initial={{opacity: 0, scale: 0.95}}
                        animate={{opacity: 1, scale: 1}}
                        exit={{opacity: 0, scale: 0.95}}
                        transition={{duration: 0.15}}
                        className={`absolute top-full mt-1 z-50 max-w-[300px] p-3 rounded-lg
                                    bg-[var(--surface-elevated)] border border-[var(--border)] shadow-elevated
                                    text-sm text-[var(--text-primary)]
                                    ${tooltipPosition === 'right' ? 'left-0' : 'right-0'}`}
                        style={{
                            maxHeight: '200px',
                            overflow: 'auto',
                        }}
                    >
                        <div className="font-medium mb-1">{task.title}</div>
                        {task.description && (
                            <div
                                className="text-[var(--text-muted)] text-xs whitespace-pre-wrap">{task.description}</div>
                        )}
                        {task.subtasks && task.subtasks.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-1">
                                {task.subtasks.map(st => (
                                    <div key={st.id} className="text-xs flex items-center gap-1.5">
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                            st.status === 'completed' ? 'bg-green-500' :
                                                st.status === 'running' ? 'bg-[var(--brand-primary)]' :
                                                    'bg-[var(--text-muted)]'
                                        }`}/>
                                        <span
                                            className={st.status === 'completed' ? 'line-through text-[var(--text-muted)]' : ''}>
                                            {st.title}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="mt-2 pt-2 border-t border-[var(--border)]">
                            <span className="text-[10px] text-[var(--text-muted)]">
                                状态: {
                                task.status === 'pending' ? '待处理' :
                                    task.status === 'running' ? '进行中' :
                                        task.status === 'completed' ? '已完成' :
                                            task.status === 'failed' || task.status === 'error' ? '失败' : task.status
                            }
                            </span>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// ─── TodoPanel 主组件 ─────────────────────────────────

interface TodoPanelProps {
    height?: string
}

export default function TodoPanel({height}: TodoPanelProps) {
    const tasks = useAgentStore(s => s.tasks)

    const completedCount = tasks.filter(t => t.status === 'completed').length

    return (
        <div className="relative flex shrink-0 min-h-0" style={{height: height || '50%'}}>
            {/* 面板主体 */}
            <div
                className="h-full w-full bg-[var(--surface)] rounded-lg shadow-card border border-[var(--border)] flex flex-col overflow-hidden"
            >
                {/* Header */}
                <div
                    className="px-3 py-2.5 border-b border-[var(--border)] flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-1.5">
                        <ListTodo className="w-3.5 h-3.5 text-[var(--text-muted)]"/>
                        <span className="text-xs font-medium text-[var(--text-secondary)]">待办列表</span>
                    </div>
                    {tasks.length > 0 && (
                        <span
                            className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-base)] text-[var(--text-muted)] border border-[var(--border)]">
                            {completedCount}/{tasks.length}
                        </span>
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-3">
                    {tasks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-32 text-center opacity-40">
                            <ListTodo className="w-8 h-8 text-[var(--text-muted)] mb-2"/>
                            <p className="text-xs text-[var(--text-muted)]">暂无待办事项</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            <AnimatePresence initial={false}>
                                {tasks.map((task, index) => (
                                    <motion.div
                                        key={task.id || index}
                                        initial={{opacity: 0, x: -10}}
                                        animate={{opacity: 1, x: 0}}
                                        exit={{opacity: 0, height: 0}}
                                    >
                                        <TaskItem task={task}/>
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        </div>
                    )}

                    {tasks.length > 0 && (
                        <div className="pt-4 border-t border-[var(--border-muted)]">
                            <div
                                className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
                                <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                                    鼠标悬停任务项查看详情和描述
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
