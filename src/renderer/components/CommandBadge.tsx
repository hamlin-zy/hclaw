/**
 * CommandBadge — 命令激活状态徽标（卡片式重设计）
 *
 * 在消息列表中标记命令激活结果（⚡ 成功 / ⚡ 失败）。
 * 仅表示命令是否被成功识别并激活，不反映任何后续执行进度或结果。
 *
 * 设计语言：
 *  - 卡片化：surface-elevated 表面 + border + 微阴影，与应用卡片体系统一
 *  - 命令名：JetBrains Mono 等宽字体，语义色高亮
 *  - 状态标签：固定「已激活」，克制不刺眼
 */

import {memo} from 'react'
import {motion} from 'framer-motion'
import type {CommandExecution} from '@shared/types'

interface CommandBadgeProps {
    commandName: string
    commandArgs?: string
    status: 'loading' | 'running' | 'done' | 'error'
    commandId?: string
}

/* ─── 状态配置 ───────────────────────────────────────────
 * loading / running / done 均为同一终态（⚡ 已激活），仅 error 区分。
 */
const OK_COLOR = 'text-[var(--success)]'
const ERROR_COLOR = 'text-[var(--error)]'

/**
 * 命令徽标 — 单条命令状态卡片
 */
export const CommandBadge = memo(function CommandBadge({
    commandName, commandArgs, status, commandId
}: CommandBadgeProps) {
    const isError = status === 'error'
    const color = isError ? ERROR_COLOR : OK_COLOR
    const label = isError ? '激活失败' : '已激活'

    // 截断参数用于 tooltip 展示完整内容
    const truncatedArgs = commandArgs && commandArgs.length > 30
        ? `${commandArgs.slice(0, 30)}...`
        : commandArgs

    return (
        <motion.div
            initial={{opacity: 0, y: 4, scale: 0.97}}
            animate={{opacity: 1, y: 0, scale: 1}}
            transition={{duration: 0.2, ease: 'easeOut'}}
            className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border bg-[var(--surface-elevated)]
                border-[var(--border)] shadow-[var(--shadow-card)]`}
            title={commandId ? `命令 ID: ${commandId}` : undefined}
        >
            {/* 图标 */}
            <span className={`flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-md
                bg-[var(--surface-muted)] ${color}`}>
                ⚡
            </span>

            {/* 命令名 + 参数 — 等宽字体 */}
            <span className="font-mono text-[11px] leading-tight truncate max-w-44">
                <span className={`font-semibold ${color}`}>{commandName}</span>
                {truncatedArgs && (
                    <span className="text-[var(--text-muted)] ml-1" title={commandArgs}>
                        {truncatedArgs}
                    </span>
                )}
            </span>

            {/* 状态标签 — 克制的辅助文字 */}
            <span className={`text-[10px] font-medium ${color} opacity-70 shrink-0`}>
                {label}
            </span>
        </motion.div>
    )
})

/**
 * CommandBadges — 命令徽标组
 *
 * 展示多个命令的状态，自动换行。
 */
export const CommandBadges = memo(function CommandBadges({commands}: { commands: CommandExecution[] }) {
    if (commands.length === 0) return null

    return (
        <div className="flex flex-wrap gap-2 my-2">
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
})

export default CommandBadge
