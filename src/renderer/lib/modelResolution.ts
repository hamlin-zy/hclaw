/**
 * 会话生效模型解析（ModelSelector / CacheRateTooltip 共用，防口径漂移）
 *
 * 口径：modelOverride → 无则当前方案 primary 角色兜底（与 selectModelForTurn 的
 * findEffectiveOverride 决策对齐；primary 只读匹配，不写库）。
 * 返回服务商/模型解析结果 + 展示文案；解析失败时给出兜底文案。
 */
import type {LLMProvider, ModelOverride, ModelSchemeRole, ProviderModel} from '@shared/types'

export interface ActiveModelResolution {
  /** 服务商 ID（providers.id）；未解析为 null */
  providerId: string | null
  /** 模型 ID（providers.models[].id）；未解析为 null */
  modelId: string | null
  /** 服务商类型（providers.type，如 custom/openai），用于匹配历史数据无 providerName 的分组 */
  providerType: string
  /** 服务商显示名（providers.name） */
  providerName: string
  /** 模型显示名（providers.models[].name，与 llmStats.model 同口径） */
  modelName: string
  /** 展示文案「{服务商名}: {模型名}」；不可解析时为 override 残值或「主力模型」 */
  label: string
}

/** 按 endpointId/modelId 查找服务商与模型（model 可能缺失 → 服务商已删除该模型） */
function findProviderModel(
  providers: LLMProvider[],
  endpointId: string | undefined,
  modelId: string | undefined,
): {provider: LLMProvider | undefined; model: ProviderModel | undefined} {
  const provider = providers.find(p => p.id === endpointId)
  return {provider, model: provider?.models.find(m => m.id === modelId)}
}

/** 服务商/模型均解析成功时的结果 */
function toResolution(provider: LLMProvider, model: ProviderModel): ActiveModelResolution {
  return {
    providerId: provider.id,
    modelId: model.id,
    providerType: provider.type,
    providerName: provider.name,
    modelName: model.name,
    label: `${provider.name}: ${model.name}`,
  }
}

export function resolveActiveModel(opts: {
  override: ModelOverride | null
  providers: LLMProvider[]
  primaryRole: ModelSchemeRole | null
}): ActiveModelResolution {
  const {override, providers, primaryRole} = opts

  if (override) {
    const {provider, model} = findProviderModel(providers, override.endpointId, override.modelId)
    if (provider && model) return toResolution(provider, model)
    // override 存在但服务商/模型不可解析（被删除/重命名）：显示 override 残值
    return {
      providerId: override.endpointId ?? null,
      modelId: override.modelId ?? null,
      providerType: provider?.type ?? '',
      providerName: override.providerName || '',
      modelName: override.modelId || '',
      label: override.modelId || override.providerName || '',
    }
  }

  // 无 override → 当前方案 primary 角色（虚拟选中语义，只读匹配）
  if (primaryRole) {
    const {provider, model} = findProviderModel(providers, primaryRole.endpointId, primaryRole.modelId)
    if (provider && model) return toResolution(provider, model)
  }

  // primary 未配置/不可解析 → 兜底文案（原「自动」）
  return {
    providerId: null,
    modelId: null,
    providerType: '',
    providerName: '',
    modelName: '',
    label: '主力模型',
  }
}
