/**
 * 模型适配器共享工具函数
 */

// ─── Provider 检测 ────────────────────────────────────────

/**
 * 判断是否为第三方 Anthropic 兼容 API（非 api.anthropic.com 官方端点）。
 *
 * 第三方兼容 API（如 DeepSeek、MiMo 等）对 thinking 块有不同格式要求：
 * - 不需要 Anthropic 专有的 signature 字段
 * - 要求所有带 tool_use 的 assistant 消息必须包含非空 thinking 块
 *
 * 检测策略：优先检查 baseUrl 是否指向非官方端点（通用检测，自动覆盖任意第三方 API）；
 * 其次回退到模型名匹配（兜底 baseUrl 未正确配置的情况）。
 */
export function isThirdPartyAnthropicAPI(model: string, baseUrl: string): boolean {
    // 有自定义 baseUrl 且非官方 Anthropic 端点 → 第三方兼容 API
    if (baseUrl) {
        const b = baseUrl.toLowerCase()
        if (!b.includes('api.anthropic.com')) {
            return true
        }
    }
    // 回退：模型名包含已知第三方前缀（baseUrl 可能未设置或通过代理指向官方端点）
    const m = model.toLowerCase()
    return m.includes('deepseek') || m.includes('mimo')
}

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
