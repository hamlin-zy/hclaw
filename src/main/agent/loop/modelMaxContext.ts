/**
 * 解析模型最大上下文 token 数
 *
 * 优先级（从高到低）：
 *   1. ModelScheme.maxContextTokens（用户在方案中显式配置）
 *   2. modelMetaContextLength（or-models.json / modelMetaRegistry 权威窗口，> 0 才生效；
 *      0 表示未命中，自动降级）
 *   3. ModelAdapter.getModelInfo().maxContextTokens（adapter 硬编码表，兜底本地模型/未收录模型）
 *   4. 默认 128000（OpenAI GPT-4o 基线）
 *
 * 集中处理 fallback，未来加新 provider 只需改这里。
 * 保持纯函数：不在此 import modelMetaRegistry（调用方负责把 registry 值作为参数传入）。
 */

export interface ResolveMaxContextInput {
    provider: string
    model: string
    modelScheme?: {maxContextTokens?: number} | null
    /** or-models.json（modelMetaRegistry）查到的窗口；0 = 未命中 → 回退下一级 */
    modelMetaContextLength?: number
    adapterInfo?: {maxContextTokens: number} | null
}

const DEFAULT_MAX_CONTEXT_TOKENS = 128000

export function resolveMaxContextTokens(input: ResolveMaxContextInput): number {
    const schemeValue = input.modelScheme?.maxContextTokens
    if (schemeValue && schemeValue > 0) return schemeValue

    const metaValue = input.modelMetaContextLength
    if (metaValue && metaValue > 0) return metaValue

    const adapterValue = input.adapterInfo?.maxContextTokens
    if (adapterValue && adapterValue > 0) return adapterValue

    return DEFAULT_MAX_CONTEXT_TOKENS
}
