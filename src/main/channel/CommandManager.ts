/**
 * ChannelCommandManager — 渠道内置快捷指令路由
 *
 * 所有渠道通用的快捷指令处理，不启动 Agent。
 * 指令以 / 开头，由 ChannelManager 在收到消息时判断并委派。
 *
 * 【容错机制】
 * 1. 显式别名映射：将常见拼写错误的命令映射到正确命令
 * 2. 编辑距离（Levenshtein）模糊匹配：未命中时自动寻找最近似命令并给出提示
 */
import {workspaceRepo} from '../repositories/sqlite/workspaceRepository'
import {skillRegistry} from '../agent/skills'
import type {ChannelRecord, CommandResult} from './types'

/**
 * 计算两个字符串之间的 Levenshtein 编辑距离
 */
function levenshteinDistance(a: string, b: string): number {
    const m = a.length
    const n = b.length
    // 使用两个滚动数组优化空间
    let prev = new Array<number>(n + 1)
    let curr = new Array<number>(n + 1)
    for (let j = 0; j <= n; j++) prev[j] = j
    for (let i = 1; i <= m; i++) {
        curr[0] = i
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            curr[j] = Math.min(
                prev[j] + 1,          // 删除
                curr[j - 1] + 1,      // 插入
                prev[j - 1] + cost,   // 替换
            )
        }
        [prev, curr] = [curr, prev]
    }
    return prev[n]
}

/**
 * 已知的命令列表，用于模糊匹配时的候选集
 */
const KNOWN_COMMANDS = [
    '/help', '/new', '/status', '/agents', '/clear',
    '/dir', '/skills', '/rename', '/chats', '/list', '/mode',
]

/**
 * 显式别名映射：常见拼写错误 → 正确命令
 * 避免 Levenshtein 计算开销，且处理编辑距离算法可能遗漏的同音/近形错误
 */
const COMMAND_ALIASES: Record<string, string> = {
    // /status 常见错误
    '/sratus': '/status',
    '/stauts': '/status',
    '/stats': '/status',
    '/stat': '/status',
    '/staus': '/status',
    // /help 常见错误
    '/hlep': '/help',
    '/halp': '/help',
    '/hepl': '/help',
    // /new 常见错误
    '/nwe': '/new',
    // /clear 常见错误
    '/clearn': '/clear',
    '/clera': '/clear',
    // /chats 常见错误
    '/chat': '/chats',
    '/chts': '/chats',
    // /rename 常见错误
    '/rname': '/rename',
    '/renmae': '/rename',
    // /skills 常见错误
    '/skill': '/skills',
    '/skils': '/skills',
    '/sklls': '/skills',
    // /dir 常见错误
    '/dic': '/dir',
    '/dri': '/dir',
    // /mode 常见错误
    '/mdoe': '/mode',
    '/mod': '/mode',
}

export class ChannelCommandManager {
    /** 处理渠道消息，返回是否命中指令 */
    handle(_channelId: string, text: string, context?: {
        binding?: any
        agentRunning?: boolean
        channelRecord?: ChannelRecord
    }): CommandResult {
        const trimmed = text.trim()
        // ? 和 ？映射到 /help
        const normalized = (trimmed === '?' || trimmed === '？') ? '/help' : trimmed
        if (!normalized.startsWith('/')) return {handled: false}

        const parts = normalized.split(/\s+/)
        let cmd = parts[0].toLowerCase()

        // ① 显式别名映射：优先匹配已知的常见拼写错误
        if (COMMAND_ALIASES[cmd]) {
            cmd = COMMAND_ALIASES[cmd]
        }

        switch (cmd) {
            case '/help':
                return {
                    handled: true,
                    reply: [
                        '📋 HClaw 快捷指令（发送 ? 也可触发本帮助）',
                        '',
                        '🔄 会话管理',
                        '  /new <工作目录编号> — 创建新会话',
                        '  /chats <页码> [编号] — 浏览/切换历史会话',
                        '  /rename <标题> — 重命名当前会话',
                        '  /clear — 清空当前对话上下文',
                        '',
                        'ℹ️ 信息查询',
                        '  /help — 显示本帮助',
                        '  /status — 查看当前对话状态',
                        '  /dir — 查看工作目录列表',
                        '  /skills — 查看可用技能列表',
                        '  /agents — 查看可用 Agent 列表',
                        '  /list — 查看全部会话列表',
                        '  /mode <模式> — 切换工作模式',
                        '',
                        '💡 发送 /new 开始与 Agent 对话',
                    ].join(' \n\n'),
                }

            case '/new':
                return {handled: true, needsNewSession: true, reply: '正在创建新会话...'}

            case '/status':
                return {
                    handled: true,
                    reply: context?.agentRunning
                        ? '🤖 Agent 正在运行中...'
                        : '⏸️ 当前会话 Agent 已停止，发送消息即可开始新对话',
                }

            case '/agents': {
                // 从 channelRecord.config 获取可用 Agent 列表（暂未实现）
                return {
                    handled: true,
                    reply: '可用 Agent 列表（请通过桌面端管理）',
                }
            }

            case '/clear':
                return {
                    handled: true,
                    reply: context?.binding
                        ? '✅ 上下文已清空'
                        : '❌ 当前无活跃会话，请先使用 /new 创建',
                }

            case '/dir': {
                const workspaces = workspaceRepo.list()
                if (workspaces.length === 0) {
                    return {handled: true, reply: '暂无可用工作区，请先在桌面端配置'}
                }
                const lines = workspaces.map((w, i) => `${i + 1}. ${w.name || w.path}`)
                return {handled: true, reply: `📁 工作目录列表:\n${lines.join('\n')}`}
            }

            case '/skills': {
                const skills = skillRegistry.getEnabled()
                if (skills.length === 0) {
                    return {handled: true, reply: '暂无可用技能'}
                }
                const lines = skills.map(s => {
                    const desc = s.description ? s.description.slice(0, 60) : ''
                    return `  ${s.name}${desc ? ` — ${desc}` : ''}`
                })
                return {
                    handled: true,
                    reply: `📦 可用 Skills（${skills.length}）:\n${lines.join('\n')}`,
                }
            }

            case '/rename': {
                const title = parts.slice(1).join(' ')
                if (!title) {
                    return {handled: true, reply: '❌ 用法: /rename <新标题>'}
                }
                if (!context?.binding) {
                    return {handled: true, reply: '❌ 当前无活跃会话，请先使用 /new 创建'}
                }
                return {handled: true, needsRename: {title}}
            }

            case '/chats': {
                const page = parseInt(parts[1], 10)
                if (isNaN(page)) {
                    return {handled: true, reply: '❌ 用法: /chats <页码> [编号]'}
                }
                if (parts.length >= 3) {
                    const idx = parseInt(parts[2], 10)
                    if (isNaN(idx) || idx < 1) {
                        return {handled: true, reply: '❌ 编号无效，请输入 1-10 之间的数字'}
                    }
                    return {handled: true, needsSwitchChat: {page, index: idx}}
                }
                return {handled: true, needsListChats: {page}}
            }

            case '/list': {
                // TODO: 将来实现列出当前渠道用户的所有会话
                return {
                    handled: true,
                    reply: '📁 会话列表功能（即将支持）',
                }
            }

            case '/mode': {
                const mode = parts[1]
                // 旧名称 → 新名称 的别名映射
                const MODE_ALIAS: Record<string, string> = {
                    work: 'primary',
                    chat: 'lightweight',
                    superbrain: 'reasoning',
                }
                const resolved = mode ? (MODE_ALIAS[mode] || mode) : ''
                const VALID_MODES = ['auto', 'primary', 'lightweight', 'reasoning']
                if (VALID_MODES.includes(resolved)) {
                    return {handled: true, reply: `✅ 工作模式已切换为: ${resolved}`}
                }
                return {
                    handled: true,
                    reply: '❌ 无效模式。支持: auto / primary / lightweight / reasoning',
                }
            }

            default: {
                // ② Levenshtein 模糊匹配：在已知命令中找最近似的
                const originalCmd = parts[0].toLowerCase()
                let bestMatch = ''
                let bestDist = Infinity
                for (const kc of KNOWN_COMMANDS) {
                    const dist = levenshteinDistance(originalCmd, kc)
                    if (dist < bestDist) {
                        bestDist = dist
                        bestMatch = kc
                    }
                }
                const suggestion = bestDist <= 2 && bestMatch
                    ? `\n你是不是想输入 ${bestMatch}？`
                    : ''
                return {
                    handled: true,
                    reply: `❌ 未知指令: ${originalCmd}${suggestion}\n发送 /help 查看可用指令`,
                }
            }
        }
    }
}

export const channelCommandManager = new ChannelCommandManager()
