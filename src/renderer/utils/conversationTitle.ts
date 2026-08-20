/**
 * 从用户消息文本生成会话标题。
 *
 * 规则（与主进程 parseCommandText 的 /^\/(\S+)\s+/ 解析语义对齐，
 * 见 src/main/agent/loop/commandTextParser.ts）：
 * 1. 以 /能力 开头（含换行或空格分隔）：移除 "/能力" 及分隔符，只用正文部分
 *    - "/能力\n任务内容" → "任务内容"
 *    - "/能力 任务内容" → "任务内容"
 *    - "/能力"（无正文）→ 回退保留 "/能力" 本身，避免空标题
 * 2. 非 /能力 开头：去除头部空格和换行即可（内部换行保留）
 */
export function deriveConversationTitle(text: string): string {
    const trimmed = text.trim()
    // // 开头的文本按普通消息处理（与 InputArea 的 !startsWith('//') 判定一致）
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        const m = trimmed.match(/^\/(\S+)\s+([\s\S]*)$/)
        if (m) {
            const body = m[2].trim()
            if (body) return body
            return `/${m[1]}`
        }
    }
    return trimmed
}
