/**
 * channel_send 工具 — 通过指定渠道向用户发送消息
 *
 * 支持纯文本、媒体文件（图片/文档/音频/视频），或图文混发。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 核心概念：
 * 1. channel_list 返回的 "机器人" ID - 机器人的标识（不可用于发送）
 * 2. channel_list 返回的 "用户" 标识 - 可发送的目标
 *
 * 发送时 toUser 参数说明：
 *   微信：从 channel_list 的"用户"列表获取，自动移除 @im.wechat 后缀
 *   飞书：从 channel_list 的"用户"列表获取，直接使用 openId（如 ou_xxx）
 *   ❌ 不要使用"机器人"ID，那是机器人自己的账号，无法向自己发消息
 *
 * 常见错误：
 *   ret=-3（用户与机器人没有会话关系）→ 用户必须先给机器人发消息建立会话
 *   ret=-2（用户不存在）→ toUser 格式错误
 *   微信 ret=-3 常因 toUser 是机器人自己的ID导致
 * ═══════════════════════════════════════════════════════════════════*/
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {ChannelRepository} from '../../../channel/ChannelRepository'
import {parentPort} from 'worker_threads'

const channelRepo = new ChannelRepository()

const inputSchema = z.object({
    /** 目标渠道名称（必填）
     * 格式：通过 channel_list 获取的 name 字段值
     * 示例：个人微信、飞书 等
     * 注意：名称必须完全匹配（包括空格）*/
    channelName: z.string()
        .describe(`目标渠道名称（必填）
通过 channel_list 返回的 name 字段值。
示例：channel_list 返回 {name: "个人微信"} → channelName 填 "个人微信"
注意：名称必须完全匹配（包括空格和标点）`),

    /** 目标用户标识（必填）- ⚠️ 重要：不同渠道格式不同
     *
     * 【微信渠道】
     * 从 channel_list 的"用户"列表中获取"机器人"行！
     * 使用 "机器人: o9xxx@im.wechat"
     *
     * 【飞书渠道】
     * 从 channel_list 的"用户"列表中获取
     * - channel_list 显示 "用户: ou_xxx" → toUser 填 "ou_xxx"（无后缀）
     *
     * */
    toUser: z.string()
        .describe(`目标用户标识（必填）- ⚠️ 不同渠道格式不同
来源：channel_list 返回的"用户"标识（不是"机器人"标识！）

【微信渠道】
- 从 channel_list 的"用户"行获取"机器人"行
- 示例：channel_list 显示 "机器人: o9xxx@im.wechat" → toUser 填 "o9xxx@im.wechat"

【飞书渠道】
- 从 channel_list 的"用户"行获取
- 示例：channel_list 显示 "用户: ou_xxx" → toUser 填 "ou_xxx"
`),

    /** 文本消息内容（与 filePath 二选一，也可同时提供）
     * 用途：向用户发送文字消息
     * 限制：单条消息建议控制在 2000 字以内
     * 特殊格式：支持 Markdown 轻量格式（部分客户端可能不支持）*/
    text: z.string().optional()
        .describe(`文本消息内容（与 filePath 二选一，也可同时提供）
用途：向用户发送文字消息
建议：单条消息控制在 2000 字以内
提示：可以与 filePath 同时提供实现图文混发`),

    /** 媒体文件完整路径（与 text 二选一，也可同时提供）
     * 格式：完整的绝对路径
     * 示例：E:\\images\\photo.png 或 C:/Users/xxx/Pictures/report.pdf
     * 支持格式：
     *   - image: PNG, JPG, GIF, WEBP, BMP
     *   - audio: MP3, WAV, OGG, M4A, AAC
     *   - video: MP4, AVI, MOV, MKV, WEBM
     *   - document: PDF, DOCX, XLSX, PPTX, TXT
     * 注意：提供此参数时必须同时指定 fileType*/
    filePath: z.string().optional()
        .describe(`媒体文件完整路径（与 text 二选一，也可同时提供）
格式：完整的绝对路径
示例：E:\\images\\photo.png 或 C:/Users/xxx/Documents/report.pdf
支持格式：
  • image: PNG, JPG, GIF, WEBP, BMP
  • audio: MP3, WAV, OGG, M4A, AAC
  • video: MP4, AVI, MOV, MKV, WEBM
  • document: PDF, DOCX, XLSX, PPTX, TXT
⚠️ 提供此参数时必须同时指定 fileType`),

    /** 媒体文件类型（当提供 filePath 时必填）
     * 可选值：
     *   - image     → 图片
     *   - audio     → 音频
     *   - video     → 视频
     *   - document  → 文档/文件
     * 注意：必须与文件实际类型匹配，否则可能发送失败*/
    fileType: z.enum(['image', 'audio', 'video', 'document']).optional()
        .describe(`媒体文件类型（当提供 filePath 时必填）
可选值：image / audio / video / document
• image    → 图片（PNG, JPG, GIF, WEBP, BMP）
• audio    → 音频（MP3, WAV, OGG, M4A, AAC）
• video    → 视频（MP4, AVI, MOV, MKV, WEBM）
• document → 文档（PDF, DOCX, XLSX, PPTX, TXT）
⚠️ 必须与文件实际类型匹配`),

    /** 上下文令牌（可选，一般无需填写）
     * 用途：保持与用户同一会话上下文
     * 使用场景：多轮对话需要保持上下文时
     * 注意：大多数情况下不需要填写*/
    contextToken: z.string().optional()
        .describe(`上下文令牌（可选，一般无需填写）
用途：保持与用户同一会话上下文
使用场景：多轮对话需要保持上下文时
提示：大多数情况下不需要填写，工具会自动处理`),
})

type ChannelSendInput = z.infer<typeof inputSchema>

export const channelSendTool: Tool<ChannelSendInput, string> = {
    name: 'channel_send',
    description: `通过指定渠道向用户发送消息（文本/媒体/图文）

【必填参数】
• channelName：渠道名称（通过 channel_list 获取）
• toUser：用户标识（通过 channel_list 获取）
• text 或 filePath：消息内容（至少提供其一）

【使用示例】
\`\`\`
// 1. 先获取渠道信息
channel_list
// 返回: {name: "个人微信", user: "xxx@im.wechat"}

// 2. 发送文本消息
channel_send(
  channelName="个人微信",
  toUser="xxx",  // 或直接使用 channel_list 返回的机器人标识
  text="消息内容"
)

// 3. 发送图片
channel_send(
  channelName="个人微信",
  toUser="xxx",
  text="这是图片",
  filePath="E:\\images\\screenshot.png",
  fileType="image"
)
\`\`\`

【错误处理】
• 错误 "ret=-2" → 用户ID不存在，请确认 toUser 是否正确
• 错误 "ret=-3" → 用户未添加机器人为好友，或用户未与机器人建立会话
• 错误 "未找到渠道" → 请先调用 channel_list 查看可用渠道
• 错误 "未启用" → 渠道被禁用，请在设置中启用`,

    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: ChannelSendInput, _context: ToolContext): Promise<ToolResult<string>> {
        try {
            // 获取渠道用户标识（内部自动处理后缀）
            const channelUserId = args.toUser

            // 1. 查找渠道
            const channels = channelRepo.list()
            const channel = channels.find(c => c.name === args.channelName)

            if (!channel) {
                const names = channels.map(c => c.name).join('、')
                const suggestion = channels.length > 0
                    ? `\n\n💡 可用渠道: ${names}`
                    : '\n\n💡 请先在 HClaw 设置中配置并启用渠道'
                return {
                    success: false,
                    output: '',
                    error: `未找到渠道"${args.channelName}"。请检查渠道名称是否完全匹配（包括空格）。${suggestion}`
                }
            }

            if (!channel.enabled) {
                return {
                    success: false,
                    output: '',
                    error: `渠道"${args.channelName}"未启用。\n\n💡 请在 HClaw 设置中启用该渠道后再试。`
                }
            }

            // 3. 校验参数
            if (!args.text && !args.filePath) {
                return {
                    success: false,
                    output: '',
                    error: '缺少消息内容。请至少提供 text（文本消息）或 filePath（媒体文件路径）其中之一。'
                }
            }

            if (args.filePath && !args.fileType) {
                return {
                    success: false,
                    output: '',
                    error: `发送文件时缺少 fileType 参数。\n\nfileType 可选值：image / audio / video / document\n示例：fileType="image"`
                }
            }

            if (!_context.channelSend) {
                return {
                    success: false,
                    output: '',
                    error: '渠道发送功能在当前上下文中不可用。请重启 HClaw 应用。'
                }
            }

            // 4. 发送消息
            if (args.text) {
                const result = await _context.channelSend(channel.id, channelUserId, args.text, args.contextToken)
                if (!result.success) {
                    // 根据错误类型提供更明确的解决方案
                    const errorHint = getErrorHint(result.error, channelUserId, channel.name)
                    return {
                        success: false,
                        output: '',
                        error: errorHint
                    }
                }
            }

            if (args.filePath && args.fileType) {
                const result = await _context.channelSend(channel.id, channelUserId, args.filePath, args.contextToken, args.fileType)
                if (!result.success) {
                    const errorHint = getMediaErrorHint(result.error, args.filePath, args.fileType)
                    return {
                        success: false,
                        output: args.text ? `文本已发送，但媒体文件发送失败。` : '',
                        error: errorHint
                    }
                }
            }

            const sentType = [
                args.text ? '文本' : '',
                args.filePath ? '媒体文件' : ''
            ].filter(Boolean).join(' + ')

            return {
                success: true,
                output: `✅ 已通过"${channel.name}"向用户 ${channelUserId} 发送${sentType}`
            }
        } catch (err) {
            return {
                success: false,
                output: '',
                error: `发送消息时发生异常: ${err instanceof Error ? err.message : '未知错误'}`
            }
        }
    }
}

/**
 * 根据错误信息生成友好的错误提示和解决方案
 */
function getErrorHint(errorMsg: string | undefined, toUser: string, channelName: string): string {
    if (!errorMsg) return '发送失败，原因未知'

    // iLink API 错误码处理
    if (errorMsg.includes('ret=-2')) {
        return `❌ 发送失败：用户不存在或用户ID格式错误
   • 当前 toUser: "${toUser}"
   • 原因: iLink API 返回 ret=-2，表示用户ID无效

💡 解决方案：
   1. 请重新调用 channel_list 获取正确的用户标识
   2. 确保 toUser 参数使用的是 channel_list 返回的原始值
   3. 如果是首次向该用户发送，需要用户先添加机器人为好友`
    }

    if (errorMsg.includes('ret=-3')) {
        return `❌ 发送失败：用户与机器人没有会话关系
   • 当前 toUser: "${toUser}"
   • 原因: iLink API 返回 ret=-3，表示该用户尚未与机器人建立会话

💡 解决方案：
   1. 确认用户已添加机器人的微信为好友
   2. 用户需要在微信中找到机器人并发起一次对话
   3. 或者让用户先向机器人发送一条消息建立会话
   4. 如果是群聊，请确认机器人已在群中且未被禁言`
    }

    if (errorMsg.includes('ret=-14')) {
        return `❌ 发送失败：会话已过期
   • 原因: iLink API 返回 ret=-14，表示会话上下文已过期

💡 解决方案：
   请重新调用 channel_list 获取新的用户标识后重试`
    }

    if (errorMsg.includes('ret=-100')) {
        return `❌ 发送失败：Bot Token 无效或已过期
   • 原因: iLink API 返回 ret=-100，表示机器人认证失败

💡 解决方案：
   请在 HClaw 设置中重新配置微信渠道的 Token`
    }

    // 其他错误
    return `❌ 发送失败: ${errorMsg}

💡 排查建议：
   1. 确认渠道"${channelName}"已正确配置
   2. 确认 toUser "${toUser}" 是有效的用户标识
   3. 确认用户已添加机器人为好友
   4. 尝试重启 HClaw 应用`
}

/**
 * 媒体文件发送错误提示
 */
function getMediaErrorHint(errorMsg: string | undefined, filePath: string, fileType: string): string {
    if (!errorMsg) return '媒体文件发送失败，原因未知'

    if (errorMsg.includes('File not found') || errorMsg.includes('ENOENT')) {
        return `❌ 媒体文件发送失败：文件不存在
   • 文件路径: "${filePath}"

💡 解决方案：
   1. 确认文件路径是否正确
   2. 确认文件是否存在
   3. 如果是相对路径，请使用绝对路径`
    }

    if (errorMsg.includes('File too large')) {
        return `❌ 媒体文件发送失败：文件过大
   • 文件路径: "${filePath}"

💡 解决方案：
   请减小文件大小后重试`
    }

    return `❌ 媒体文件发送失败: ${errorMsg}
   • 文件: ${filePath}
   • 类型: ${fileType}`
}
