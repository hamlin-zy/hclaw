/**
 * UserCommandBubble — 用户命令消息徽章气泡
 *
 * 当用户消息以 /能力 开头（Ctrl+K 选择或手动输入）时，
 * 将命令名渲染为带类型图标的能力徽章，任务内容以普通文本展示。
 *
 * 设计要点：
 *  - 纯渲染层组件，不修改消息内容，不影响 Agent Loop 的命令识别（detectCommandContext）
 *  - 解析逻辑在 lib/userCommandParse.ts（纯函数，可独立测试），此处仅做 UI 渲染
 *  - 类型图标约定：skill 🛠️ 紫 / agent 🤖 蓝 / command(plugin|user) ⚡ 橙或灰
 *  - 非命令消息返回 null，由外层（MessageBubble）降级为纯文本渲染
 */

import {memo} from 'react'
import {parseUserCommandContext, type UserCommandContext} from '../../lib/userCommandParse'

// re-export 供 MessageBubble 使用（保持单一实现源）
export {parseUserCommandContext} from '../../lib/userCommandParse'

// ─── 类型配置 ──────────────────────────────────────────

const TYPE_STYLE = {
    skill: {icon: '🛠️', color: 'text-[#8b5cf6]', bg: 'bg-[#8b5cf6]/10', label: '技能'},
    agent: {icon: '🤖', color: 'text-[#0ea5e9]', bg: 'bg-[#0ea5e9]/10', label: '代理'},
    user: {icon: '⚡', color: 'text-[#f97316]', bg: 'bg-[#f97316]/10', label: '命令'},
    plugin: {icon: '⚡', color: 'text-[#6b7280]', bg: 'bg-[#6b7280]/10', label: '命令'},
} as const

interface UserCommandBubbleProps {
    ctx: UserCommandContext
}

/**
 * 用户命令徽章气泡
 * 渲染：能力徽章（图标 + 名称 + 类型标签）+ 任务内容
 */
export const UserCommandBubble = memo(function UserCommandBubble({ctx}: UserCommandBubbleProps) {
    const style = TYPE_STYLE[ctx.type]

    return (
        <div className="min-w-0">
            {/* 能力徽章 */}
            <div className="flex items-center gap-2 mb-1.5">
                <span
                    className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-sm ${style.bg}`}>
                    {style.icon}
                </span>
                <span className={`text-sm font-medium truncate ${style.color}`}>
                    {ctx.commandName}
                </span>
                <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded ${style.bg} ${style.color}`}>
                    {style.label}
                </span>
            </div>
            {/* 任务内容 */}
            {ctx.commandArgs && (
                <div className="text-sm leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
                    {ctx.commandArgs}
                </div>
            )}
        </div>
    )
})

export default UserCommandBubble
