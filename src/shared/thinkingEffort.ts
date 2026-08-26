/**
 * 思考强度（thinkingEffort）共享工具
 *
 * 档位与语义以官方文档为准：
 * - OpenAI reasoning.effort：none/minimal/low/medium/high/xhigh/max（model-dependent，gpt-5.5+ 默认 medium）
 * - Anthropic effort：low/medium/high/xhigh/max（默认 high，且 high ≡ 不传参数）
 * - `auto` 是本应用哨兵值，不在任何 API 中出现：Anthropic → 不传（等效 high）；
 *   OpenAI 系适配器降级为 high（兼容第三方网关）。
 */

import type {ModelOverride, ModelScheme, ModelRoleConfig} from './types/model'

export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 单个档位选项（供思考强度选择器渲染） */
export interface EffortOption {
    value: ThinkingEffort
    label: string
    /** 补充说明（title/副文案） */
    hint?: string
}

/**
 * 按服务商协议类型动态输出档位列表
 * providerType: 'anthropic' 走 Anthropic effort 语义；其余（openai/ollama/custom 等）走 OpenAI 语义
 */
export function getEffortOptions(providerType?: string): EffortOption[] {
    const isAnthropic = providerType === 'anthropic'
    return [
        {
            value: 'auto',
            label: '自动',
            hint: isAnthropic
                ? '跟随服务商默认（等效 high）'
                : '由适配器决定（OpenAI 官方默认 medium，兼容端点按 high 处理）',
        },
        {value: 'low', label: 'low'},
        {value: 'medium', label: 'medium'},
        {value: 'high', label: 'high'},
        {
            value: 'xhigh',
            label: 'xhigh',
            hint: '仅部分新模型原生支持；不支持时自动降级为 high',
        },
        {
            value: 'max',
            label: 'max',
            hint: '仅部分新模型原生支持；不支持时自动降级为 high',
        },
    ]
}

/** 合法档位白名单：非白名单值（含 ''）视为未配置，不透传进 LLM API */
const VALID_EFFORTS: readonly string[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

function isValidEffort(value: unknown): value is ThinkingEffort {
    return VALID_EFFORTS.includes(value as string)
}

/**
 * 会话 override 的思考强度解析规则（纯函数，主进程/渲染端共用）：
 * 1. override 显式携带 thinkingEffort 且为合法档位 → 直接使用
 * 2. 该模型恰好是某方案角色在用的模型（endpointId+modelId 匹配）→ 继承该角色的 thinkingEffort
 * 3. 兜底 → 'auto'
 */
export function resolveOverrideThinkingEffort(
    override: Pick<ModelOverride, 'endpointId' | 'modelId' | 'thinkingEffort'>,
    scheme?: ModelScheme | null,
): ThinkingEffort {
    if (isValidEffort(override.thinkingEffort)) {
        return override.thinkingEffort
    }
    if (scheme) {
        const matched = (scheme.roles as ModelRoleConfig[]).find(
            r => r.endpointId === override.endpointId && r.modelId === override.modelId,
        )
        if (matched?.thinkingEffort && isValidEffort(matched.thinkingEffort)) {
            return matched.thinkingEffort
        }
    }
    return 'auto'
}
