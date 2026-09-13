import type {VersionMeta} from '@/main/agent/mcp/versionUtils'

/**
 * 可观测的 McpVersionStore 测试替身。
 *
 * - store:      传给 new McpVersionManager({store})
 * - getSnapshot():  读取当前持久化状态（等价于旧的 (manager as any).versionMap.get(...)）
 * - getSetAllCalls(): setAll 被调用次数（用于断言"变更是否回写"）
 * - getLastSetAll(): 末次写回内容（用于断言"单一写回点"）
 */
export function createSeededVersionStore(seed: Record<string, VersionMeta> = {}) {
  let data: Record<string, VersionMeta> = {...seed}
  let setAllCalls = 0
  let lastSetAll: Record<string, VersionMeta> | null = null

  const store = {
    getAll: () => ({...data}),
    setAll: (meta: Record<string, VersionMeta>) => {
      data = {...meta}
      setAllCalls++
      lastSetAll = {...meta}
    },
  }

  return {
    store,
    getSnapshot: () => ({...data}),
    getSetAllCalls: () => setAllCalls,
    getLastSetAll: () => lastSetAll,
  }
}
