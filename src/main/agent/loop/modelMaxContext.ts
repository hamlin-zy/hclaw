/**
 * 解析模型最大上下文 token 数
 *
 * 优先级（从高到低）：
 *   1. ModelScheme.maxContextTokens（用户在方案中显式配置）
 *   2. ModelAdapter.getModelInfo().maxContextTokens（adapter 硬编码表）
 *   3. 默认 128000（OpenAI GPT-4o 基线）
 *
 * 集中处理 fallback，未来加新 provider 只需改这里。
 */

export interface ResolveMaxContextInput {
    provider: string
    model: string
    modelScheme?: {maxContextTokens?: number} | null
    adapterInfo?: {maxContextTokens: number} | null
}

const DEFAULT_MAX_CONTEXT_TOKENS = 128000

export function resolveMaxContextTokens(input: ResolveMaxContextInput): number {
    const schemeValue = input.modelScheme?.maxContextTokens
    if (schemeValue && schemeValue > 0) return schemeValue

    const adapterValue = input.adapterInfo?.maxContextTokens
    if (adapterValue && adapterValue > 0) return adapterValue

    return DEFAULT_MAX_CONTEXT_TOKENS
}
