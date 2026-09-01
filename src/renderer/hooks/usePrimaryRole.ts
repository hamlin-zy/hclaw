import {useMemo} from 'react'
import {useModelSchemeStore} from '../stores/modelSchemeStore'
import {useConversationStore} from '../stores/conversationStore'
import type {ModelSchemeRole} from '@shared/types'

/**
 * 按角色名取当前方案中「启用且配齐 endpointId/modelId」的角色配置（只读匹配，不写库）。
 * 用 useModelSchemeStore 订阅（schemes / activeSchemeId），方案变更时自动重算。
 */
function useSchemeRole(role: 'primary' | 'lightweight'): ModelSchemeRole | null {
  const schemes = useModelSchemeStore(s => s.schemes)
  const activeSchemeId = useModelSchemeStore(s => s.activeSchemeId)
  return useMemo(() => {
    const scheme = schemes.find(s => s.id === activeSchemeId)
    return scheme?.roles.find(r => r.role === role && r.enabled && r.endpointId && r.modelId) ?? null
  }, [schemes, activeSchemeId, role])
}

/**
 * 当前方案 primary 角色（无 override 时的兜底模型；只读匹配，不写库）。
 *
 * ModelSelector / CacheRateTooltip / useWindowUsage 共用，防口径漂移：
 * 仅返回「启用且配齐 endpointId/modelId」的 primary 角色，未配置返回 null。
 */
export function usePrimaryRole() {
  return useSchemeRole('primary')
}

/**
 * 会话默认角色（无 override 时与运行层 defaultRoleForTrace 对齐，防口径漂移）：
 * - 子会话（agentTool 创建，meta.parentConvId 非空）→ lightweight（运行层 L→P→R）
 * - 其余（主会话 / handoff 独立会话）→ primary（运行层 P→L→R）
 *
 * 子会话判定：conversationStore 各工作区会话列表按 id 查 parentConvId
 * （IPC conversation-list-by-workspace 返回完整 meta，含 parentConvId）。
 * 列表中找不到（未加载等）→ 视为主会话，兜底 primary（与旧行为一致）。
 */
export function useDefaultRoleForSession(conversationId: string): ModelSchemeRole | null {
  const isChildSession = useConversationStore(s =>
    !!conversationId &&
    Object.values(s.workspaces ?? {}).some(ws =>
      ws?.conversations.some(c => c.id === conversationId && c.parentConvId),
    ),
  )
  const lightweight = useSchemeRole('lightweight')
  const primary = useSchemeRole('primary')
  // 子会话降级链 L→P→R：lightweight 未启用/未配置时升 primary（与运行层一致）
  return isChildSession ? (lightweight ?? primary) : primary
}
