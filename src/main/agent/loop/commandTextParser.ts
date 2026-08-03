/**
 * 命令文本解析 — 从用户消息文本中提取命令名与任务内容
 *
 * 从 detectCommandContext（src/main/agent/loop/setup.ts）抽取的纯函数，
 * 便于独立测试。行为与原有内联逻辑完全等价。
 *
 * 命令消息格式（两种分隔均可）：
 *  - Ctrl+K 弹窗：/能力\n任务内容（换行分隔）
 *  - 手动输入：  /能力 任务内容（空格分隔）
 */

export interface ParsedCommandText {
    commandName: string
    commandArgs?: string
}

/**
 * 解析命令文本
 * @param messageContent 消息纯文本内容
 * @returns 命令名与参数；非命令消息（不以 / 开头）或无效命令返回 null
 */
export function parseCommandText(messageContent: string): ParsedCommandText | null {
    const trimmed = messageContent.trim()
    if (!trimmed.startsWith('/')) return null

    // /命令名 [空格或换行] 任务内容（\S+ 匹配命令名，\s+ 匹配第一个空白分隔符，[\s\S]* 保留剩余含多行）
    const cmdMatch = trimmed.match(/^\/(\S+)\s+([\s\S]*)$/)

    const commandName = cmdMatch ? cmdMatch[1] : trimmed.slice(1)
    if (!commandName) return null

    const commandArgs = cmdMatch ? cmdMatch[2].trim() || undefined : undefined

    return {commandName, commandArgs}
}
