import {useEffect, useMemo, useState} from 'react'
import {computeUsagePct, type MessageTokenStats} from '@shared/messageTokenStats'
import {useAgentStore} from '../stores/agentStore'
import {useModelSchemeStore} from '../stores/modelSchemeStore'
import {useLLMStore} from '../stores/llmStore'

/**
 * 上下文窗口使用率（stats 由调用方传入，避免重复计算）：
 * - numerator = currentInputTokens + currentCacheReadTokens（最近一次请求的上下文占用）
 * - contextLength = OpenRouter 补全的窗口大小（0 = 未知）
 * - pct = computeUsagePct(numerator, contextLength)
 *
 * 分母基于「当前工作模式对应的模型名」查询（而非历史消息的模型名）：
 *   workMode（useAgentStore）→ activeScheme.roles.find(r => r.role === workMode)
 *   → role.endpointId + role.modelId（provider_models 的 UUID）
 *   → providers.find(p => p.id === endpointId).models.find(m => m.id === modelId).name
 *
 * 工作模式 / 方案 / 模型配置变化时重查（不依赖 token 变化）。
 */
export function useWindowUsage(stats: MessageTokenStats) {
  const workMode = useAgentStore(s => s.workMode)
  const activeSchemeId = useModelSchemeStore(s => s.activeSchemeId)
  const schemes = useModelSchemeStore(s => s.schemes)
  const providers = useLLMStore(s => s.providers)

  // 当前工作模式 → 方案角色 → 人类可读模型名（provider_models.id 是 UUID，需解析）
  const currentModelName = useMemo(() => {
    const scheme = schemes.find(s => s.id === activeSchemeId)
    if (!scheme) return ''
    const role = scheme.roles.find(r => r.role === workMode)
    if (!role?.enabled) return ''
    const provider = providers.find(p => p.id === role.endpointId)
    const model = provider?.models.find(m => m.id === role.modelId)
    return model?.name || ''
  }, [schemes, activeSchemeId, workMode, providers])

  const [contextLength, setContextLength] = useState(0)

  useEffect(() => {
    if (!currentModelName) {
      setContextLength(0)
      return
    }
    let cancelled = false
    window.electronAPI?.modelMetaGetWindow?.(currentModelName)
      .then(r => {
        if (!cancelled) setContextLength(r?.contextLength || 0)
      })
      .catch(() => {
        if (!cancelled) setContextLength(0)
      })
    return () => {
      cancelled = true
    }
  }, [currentModelName])

  const numerator = stats.currentInputTokens + stats.currentCacheReadTokens
  const pct = computeUsagePct(numerator, contextLength)

  return {contextLength, pct}
}
