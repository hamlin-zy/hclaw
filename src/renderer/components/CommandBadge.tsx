/**
 * CommandBadge — 命令执行状态徽标
 *
 * 在消息列表中展示命令匹配和执行状态。
 */

import {motion} from 'framer-motion'
import type {CommandExecution} from '@shared/types'

interface CommandBadgeProps {
    commandName: string
    commandArgs?: string
    status: 'loading' | 'running' | 'done' | 'error'
    commandId?: string
}

const statusConfig = {
    loading: {
        color: 'text-[var(--brand-primary)]',
        bg: 'bg-[var(--brand-primary)]/12',
        border: 'border-[var(--brand-primary)]/40',
        icon: (
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
            </svg>
        ),
        label: '已激活',
    },
    running: {
        color: 'text-[var(--brand-primary)]',
        bg: 'bg-[var(--brand-primary)]/12',
        border: 'border-[var(--brand-primary)]/40',
        icon: (
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
            </svg>
        ),
        label: '执行中',
    },
    done: {
        color: 'text-[var(--success)]',
        bg: 'bg-[var(--success)]/12',
        border: 'border-[var(--success)]/40',
        icon: (
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
        ),
        label: '已完成',
    },
    error: {
        color: 'text-[var(--error)]',
        bg: 'bg-[var(--error)]/12',
        border: 'border-[var(--error)]/40',
        icon: (
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
        ),
        label: '失败',
    },
}

export function CommandBadge({commandName, commandArgs, status, commandId}: CommandBadgeProps) {
    const cfg = statusConfig[status]

    return (
        <motion.div
            initial={{opacity: 0, scale: 0.9}}
            animate={{opacity: 1, scale: 1}}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium border ${cfg.bg} ${cfg.color} ${cfg.border}`}
            title={commandId ? `命令 ID: ${commandId}` : undefined}
        >
            {cfg.icon}
            <span className="truncate max-w-32">
                {commandName}
                {commandArgs && (
                    <span className="opacity-60 ml-1 truncate max-w-48" title={commandArgs}>
                        {commandArgs.length > 20 ? `${commandArgs.slice(0, 20)}...` : commandArgs}
                    </span>
                )}
            </span>
            <span className="opacity-60">{cfg.label}</span>
        </motion.div>
    )
}

/**
 * CommandBadges — 命令徽标组
 *
 * 展示多个命令的状态。
 */
export function CommandBadges({commands}: { commands: CommandExecution[] }) {
    if (commands.length === 0) return null

    return (
        <div className="flex flex-wrap gap-1.5 my-2">
            {commands.map((cmd, index) => (
                <CommandBadge
                    key={`${cmd.commandId}-${index}`}
                    commandName={cmd.commandName}
                    commandArgs={cmd.commandArgs}
                    status={cmd.status}
                    commandId={cmd.commandId}
                />
            ))}
        </div>
    )
}
