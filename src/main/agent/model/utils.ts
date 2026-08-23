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
