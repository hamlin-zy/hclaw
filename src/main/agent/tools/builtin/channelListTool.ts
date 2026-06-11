/**
 * channel_list 工具 — 列出已连接的渠道
 *
 * LLM 在调用 channel_send 前，先调用此工具获取可用渠道列表，
 * 以确定目标用户的接收渠道。返回结果中包含该渠道绑定的用户标识，
 * LLM 可直接将其作为 channel_send 的 toUser 参数使用。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {ChannelRepository} from '../../../channel/ChannelRepository'
import {getDatabase} from '../../../repositories/sqlite'

const channelRepo = new ChannelRepository()

const inputSchema = z.object({})

type ChannelListInput = z.infer<typeof inputSchema>

export const channelListTool: Tool<ChannelListInput, string> = {
    name: 'channel_list',
    description: '列出所有已连接（含正在连接）的渠道，包含渠道名称、类型（wechat/feishu）、连接状态' +
        '和该渠道绑定的用户标识列表。' +
        '使用 channel_send 发送消息前建议先调用此工具获取可用渠道信息和目标用户标识（toUser）。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(_args: ChannelListInput, _context: ToolContext): Promise<ToolResult<string>> {
        try {
            const channels = channelRepo.list()
            const connected = channels.filter(c => c.enabled)

            if (connected.length === 0) {
                return {
                    success: true,
                    output: '当前没有已配置的渠道。'
                }
            }

            // 查询该渠道下绑定的用户标识
            const getBindings = (channelId: string): { userKey: string; updatedAt: number }[] => {
                try {
                    const rows = getDatabase().prepare(
                        'SELECT channel_key, updated_at FROM channel_bindings WHERE channel_id = ? ORDER BY updated_at DESC'
                    ).all(channelId) as Array<{ channel_key: string; updated_at: number }>
                    return rows.map(r => ({userKey: r.channel_key, updatedAt: r.updated_at}))
                } catch {
                    return []
                }
            }

            const lines = connected.map(c => {
                const icon = c.status === 'connected' ? '✅' : c.status === 'connecting' ? '🔄' : '⏹️'
                const statusText = c.statusMessage ? ` (${c.statusMessage})` : ''
                const bindings = getBindings(c.id)
                const botUserId = (c.config as any)?.userId
                const botUserText = botUserId ? `\n   机器人: ${botUserId}` : ''
                const usersText = bindings.length > 0
                    ? `\n   用户: ${bindings.map(b => b.userKey).join('、')}`
                    : ''
                return `${icon} 名称: ${c.name} | 类型: ${c.type} | 状态: ${c.status}${statusText}${botUserText}${usersText}`
            })

            return {
                success: true,
                output: `可用渠道 (${connected.length}):\n` + lines.join('\n')
            }
        } catch (err) {
            return {
                success: false,
                output: '',
                error: err instanceof Error ? err.message : '获取渠道列表失败'
            }
        }
    },
}
