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

/**
 * 思考强度档位。
 * - `disabled`：会话级「显式禁用」哨兵值（仅 override 链路），任何 API 中都不出现。
 *   用于表达「这个会话关闭思考」，且在 execute.ts 中被归一化为 undefined，
 *   同时跳过 reasoning 角色的 `?? auto` 兜底（否则禁用会被 auto 覆盖）。
 */
export type ThinkingEffort = 'disabled' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
const VALID_EFFORTS: readonly string[] = ['disabled', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']

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

/** 会话 override 写入决策的输入 */
export interface OverrideEffortWriteInput {
    /** 新选中的模型（override 的 endpointId/modelId） */
    endpointId: string
    modelId: string
    /** 当前生效方案（可为空） */
    scheme?: ModelScheme | null
    /** 会话默认角色（主会话 primary / 子会话 lightweight），只取其档位（防御脏值） */
    defaultRole?: {thinkingEffort?: unknown} | null
    /** 当前 override 已有的档位（可能是任意脏值） */
    currentEffort?: unknown
}

/**
 * 会话 override 写入时的思考强度决策（纯函数，写入侧专用）：
 * 1. 当前 override 已有合法档位（含 `disabled` 哨兵）→ 原样沿用（保护用户显式选择）
 * 2. 新模型命中方案中某角色（endpointId+modelId 匹配，取 `find` 首个匹配项，
 *    与读取侧 resolveOverrideThinkingEffort 口径一致）且该角色档位合法 → 用该角色档位
 * 3. 未命中 → 会话默认角色配了合法档位 → 用该角色档位
 * 4. 以上都不满足 → 'auto'
 *
 * 写入值恒为合法档位，故读取侧第 1 级必然直接命中 ⟹ 徽章显示 = 实际发送。
 */
export function resolveOverrideEffortToWrite(input: OverrideEffortWriteInput): ThinkingEffort {
    if (isValidEffort(input.currentEffort)) {
        return input.currentEffort
    }
    if (input.scheme) {
        const matched = (input.scheme.roles as ModelRoleConfig[]).find(
            r => r.endpointId === input.endpointId && r.modelId === input.modelId,
        )
        if (matched?.thinkingEffort && isValidEffort(matched.thinkingEffort)) {
            return matched.thinkingEffort
        }
    }
    const roleEffort = input.defaultRole?.thinkingEffort
    if (isValidEffort(roleEffort)) {
        return roleEffort
    }
    return 'auto'
}
