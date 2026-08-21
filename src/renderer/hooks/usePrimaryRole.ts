import {useMemo} from 'react'
import {useModelSchemeStore} from '../stores/modelSchemeStore'

/**
 * 当前方案 primary 角色（无 override 时的兜底模型；只读匹配，不写库）。
 *
 * ModelSelector / CacheRateTooltip / useWindowUsage 共用，防口径漂移：
 * 仅返回「启用且配齐 endpointId/modelId」的 primary 角色，未配置返回 null。
 * 用 useModelSchemeStore 订阅（schemes / activeSchemeId），方案变更时自动重算。
 */
export function usePrimaryRole() {
  const schemes = useModelSchemeStore(s => s.schemes)
  const activeSchemeId = useModelSchemeStore(s => s.activeSchemeId)
  return useMemo(() => {
    const scheme = schemes.find(s => s.id === activeSchemeId)
    return scheme?.roles.find(r => r.role === 'primary' && r.enabled && r.endpointId && r.modelId) ?? null
  }, [schemes, activeSchemeId])
}
