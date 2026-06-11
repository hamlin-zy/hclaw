import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { fileStorage } from './fileStorage'

/**
 * 通用 CRUD Store 工厂。
 *
 * 为常见的数据集合提供统一的 add / update / remove 操作，
 * 通过 options 允许各 store 定制字段名、方法名、默认值、添加行为等。
 */

export interface CrudStoreConfig<T extends { id: string }> {
  /** persist key（createCrudStore 必填，buildCrudSlice 可选） */
  name?: string
  /** 集合字段名（如 'mcpServers'、'credentials'） */
  itemsKey: string
  /** addItem 方法名（如 'addMCPServer'） */
  addMethodName?: string
  /** updateItem 方法名（如 'updateMCPServer'），不提供则不暴露 */
  updateMethodName?: string
  /** removeItem 方法名（如 'removeMCPServer'），不提供则不暴露 */
  removeMethodName?: string
  /**
   * 添加时为 newItem 填充额外默认字段。
   * 工厂自动生成 id，此回调补充其余字段。
   */
  defaults?: (input: Omit<T, 'id'>) => Partial<T>
  /**
   * 自定义 add 行为（如 auditLog 的前插 + 截断）。
   * 返回新的 items 数组。
   */
  customAdd?: (currentItems: T[], newItem: T) => T[]
}

/**
 * 构建一个 CRUD state 切片，供各 store 直接解构到 create() 中。
 *
 * 用法：
 * ```ts
 * const crud = buildCrudSlice<MCPServer, McpStore>({ ... })
 * export const useXxxStore = create<XxxStore>()(
 *   persist((set) => crud(set), { ... })
 * )
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zustand store factory: dynamic state shape, explicit any required for generic store building
export function buildCrudSlice<T extends { id: string }, TStore = Record<string, unknown>>(
  config: CrudStoreConfig<T>
) {
  const {
    itemsKey,
    addMethodName = 'addItem',
    updateMethodName,
    removeMethodName = 'removeItem',
    defaults,
    customAdd,
  } = config

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zustand set function accepts any state shape
  return (set: (fn: (state: Record<string, unknown>) => Record<string, unknown>) => void): TStore => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zustand slice builder: dynamic key-value pairs
    const slice: Record<string, unknown> = {
      [itemsKey]: [] as T[],
    }

    slice[addMethodName] = (item: Omit<T, 'id'>) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zustand set callback state type
      set((state: Record<string, unknown>) => {
        const newId = crypto.randomUUID()
        const base = { ...item, id: newId } as T
        const newItem = defaults ? { ...base, ...defaults(item) } : base
        const currentItems = (state[itemsKey] as T[]) || []
        const nextItems = customAdd
          ? customAdd(currentItems, newItem)
          : [...currentItems, newItem]
        return { [itemsKey]: nextItems }
      })

    if (updateMethodName) {
      slice[updateMethodName] = (id: string, updates: Partial<T>) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zustand set callback state type
        set((state: Record<string, unknown>) => ({
          [itemsKey]: ((state[itemsKey] as T[]) || []).map((item) =>
            item.id === id ? { ...item, ...updates } : item
          ),
        }))
    }

    if (removeMethodName) {
      slice[removeMethodName] = (id: string) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zustand set callback state type
        set((state: Record<string, unknown>) => ({
          [itemsKey]: ((state[itemsKey] as T[]) || []).filter(
            (item) => item.id !== id
          ),
        }))
    }

    return slice as TStore
  }
}

/**
 * 一站式创建带 persist 的 CRUD store。
 *
 * 对于没有额外字段/方法的简单 store，可以直接用此函数一步到位。
 * 对于有额外需求的 store，可以基于 buildCrudSlice 手动组合。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zustand persist store: dynamic state shape
export function createCrudStore<T extends { id: string }>(
  config: CrudStoreConfig<T> & Required<Pick<CrudStoreConfig<T>, 'name'>>
) {
  const { name, ...rest } = config
  const buildSlice = buildCrudSlice<T>(rest)

  return create<Record<string, unknown>>()(
    persist(
      (set) => ({
        ...buildSlice(set),
      }),
      { name: name!, storage: fileStorage as PersistStorage<Record<string, unknown>> }
    )
  )
}