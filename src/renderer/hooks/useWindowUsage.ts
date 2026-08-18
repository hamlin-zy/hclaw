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
 * 分母基于「当前生效模型名」查询（而非历史消息的模型名）：
 *   优先取运行态模型提示 agentState.currentModelName（InputToolbar 同源）；
 *   为空（未运行）时退化为 primary 角色解析：
 *   → activeScheme.roles.find(r => r.role === 'primary' && enabled)
 *   → role.endpointId + role.modelId（provider_models 的 UUID）
 *   → providers.find(p => p.id === endpointId).models.find(m => m.id === modelId).name
 *
 * 模型名 / 方案 / 模型配置变化时重查（不依赖 token 变化）。
 */
export function useWindowUsage(stats: MessageTokenStats) {
  const agentState = useAgentStore(s => s.agentState)
  const activeSchemeId = useModelSchemeStore(s => s.activeSchemeId)
  const schemes = useModelSchemeStore(s => s.schemes)
  const providers = useLLMStore(s => s.providers)

  // 当前生效模型名：取运行态模型提示（InputToolbar 同源）；空则退化为 primary 角色解析
  const currentModelName = useMemo(() => {
    if (agentState.currentModelName) return agentState.currentModelName
    const scheme = schemes.find(s => s.id === activeSchemeId)
    if (!scheme) return ''
    const role = scheme.roles.find(r => r.role === 'primary' && r.enabled)
    if (!role) return ''
    const provider = providers.find(p => p.id === role.endpointId)
    const model = provider?.models.find(m => m.id === role.modelId)
    return model?.name || ''
  }, [schemes, activeSchemeId, agentState.currentModelName, providers])

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
