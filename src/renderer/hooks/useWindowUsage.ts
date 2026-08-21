import {useEffect, useMemo, useState} from 'react'
import {computeUsagePct, type MessageTokenStats} from '@shared/messageTokenStats'
import {useAgentStore} from '../stores/agentStore'
import {useLLMStore} from '../stores/llmStore'
import {usePrimaryRole} from './usePrimaryRole'

/**
 * 模型上下文窗口大小（contextLength）查询 hook（useWindowUsage / CacheRateTooltip 共用）：
 * - modelName 为空 → 0（不查询）
 * - 查询失败 / 返回空 → 0（OpenRouter 未补全窗口时视为未知）
 * - modelName 变化时重查；换名/卸载时取消挂起的响应，防旧结果覆盖新模型
 */
export function useModelContextLength(modelName: string): number {
  const [contextLength, setContextLength] = useState(0)

  useEffect(() => {
    if (!modelName) {
      setContextLength(0)
      return
    }
    let cancelled = false
    window.electronAPI?.modelMetaGetWindow?.(modelName)
      .then(r => {
        if (!cancelled) setContextLength(r?.contextLength || 0)
      })
      .catch(() => {
        if (!cancelled) setContextLength(0)
      })
    return () => {
      cancelled = true
    }
  }, [modelName])

  return contextLength
}

/**
 * 上下文窗口使用率（stats 由调用方传入，避免重复计算）：
 * - numerator = currentInputTokens + currentCacheReadTokens（最近一次请求的上下文占用）
 * - contextLength = OpenRouter 补全的窗口大小（0 = 未知）
 * - pct = computeUsagePct(numerator, contextLength)
 *
 * 分母模型名解析（按优先级）：
 *   1. 显式传入 modelName（徽章环：生效模型解析结果，与分子同口径；
 *      防止空闲时 agentState.currentModelName 清空回退 primary 与 override 生效模型不一致）
 *   2. 运行态模型提示 agentState.currentModelName（InputToolbar 同源；流式期间有值）
 *   3. 为空（未运行）时退化为 primary 角色解析：
 *   → activeScheme.roles.find(r => r.role === 'primary' && enabled)
 *   → role.endpointId + role.modelId（provider_models 的 UUID）
 *   → providers.find(p => p.id === endpointId).models.find(m => m.id === modelId).name
 *
 * 模型名 / 方案 / 模型配置变化时重查（不依赖 token 变化）。
 */
export function useWindowUsage(stats: MessageTokenStats, modelName?: string) {
  const agentState = useAgentStore(s => s.agentState)
  const providers = useLLMStore(s => s.providers)
  const primaryRole = usePrimaryRole()

  // 当前生效模型名：显式参数优先；否则取运行态模型提示（InputToolbar 同源）；空则退化为 primary 角色解析
  const currentModelName = useMemo(() => {
    if (modelName) return modelName
    if (agentState.currentModelName) return agentState.currentModelName
    if (!primaryRole) return ''
    const provider = providers.find(p => p.id === primaryRole.endpointId)
    const model = provider?.models.find(m => m.id === primaryRole.modelId)
    return model?.name || ''
  }, [modelName, agentState.currentModelName, primaryRole, providers])

  const contextLength = useModelContextLength(currentModelName)

  const numerator = stats.currentInputTokens + stats.currentCacheReadTokens
  const pct = computeUsagePct(numerator, contextLength)

  return {contextLength, pct}
}
