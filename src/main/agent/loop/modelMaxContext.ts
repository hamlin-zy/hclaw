/**
 * 解析模型最大上下文 token 数
 *
 * 优先级（从高到低）：
 *   1. modelMetaContextLength（or-models.json / modelMetaRegistry 权威窗口，> 0 才生效；
 *      0 表示未命中，自动降级）
 *   2. 默认 1000000（1M 兜底，避免短窗口模型被误判超窗）
 *
 * 集中处理 fallback，未来加新 provider 只需改这里。
 * 保持纯函数：不在此 import modelMetaRegistry（调用方负责把 registry 值作为参数传入）。
 */

export interface ResolveMaxContextInput {
    /** or-models.json（modelMetaRegistry）查到的窗口；0 = 未命中 → 回退默认值 */
    modelMetaContextLength?: number
}

const DEFAULT_MAX_CONTEXT_TOKENS = 1000000

export function resolveMaxContextTokens(input: ResolveMaxContextInput): number {
    const metaValue = input.modelMetaContextLength
    if (metaValue && metaValue > 0) return metaValue

    return DEFAULT_MAX_CONTEXT_TOKENS
}
