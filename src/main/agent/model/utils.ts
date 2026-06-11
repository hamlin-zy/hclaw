/**
 * 模型适配器共享工具函数
 */

/**
 * 注入 additionalContext 到消息中
 * Claude Code 规范：在最后一条 user 消息的 content 末尾追加
 * 这样可以最大化缓存命中（缓存点在 additionalContext 之前）
 *
 * 使用 any[] 是因为三种 adapter 的消息类型结构不同（Anthropic/OpenAI/Gemini），
 * 但函数只操作 role='user' 的消息并修改其 content 字段，运行时类型安全。
 */
export function injectAdditionalContext(
    messages: any[],
    additionalContext: string,
    label: string = '📎 背景信息:\n'
): any[] {
    const text = `\n\n${label}${additionalContext}`
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                msg.content += text
            } else if (Array.isArray(msg.content)) {
                msg.content.push({ type: 'text', text })
            }
            break
        }
    }
    return messages
}
