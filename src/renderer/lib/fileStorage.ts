import type { PersistStorage, StorageValue } from 'zustand/middleware'

/**
 * Zustand persist storage adapter that reads/writes JSON files
 * in ~/.hclaw/ via Electron IPC.
 *
 * zustand persist v4 需要 PersistStorage 接口：
 * - getItem 返回 StorageValue<T>（包含 state 和 version）
 * - setItem 接收 StorageValue<T>
 *
 * 内部通过 JSON round-trip 过滤函数等不可序列化属性，
 * 否则 Electron IPC 结构化克隆会报错。
 */
export const fileStorage: PersistStorage<unknown> = {
  getItem: async (name: string): Promise<StorageValue<unknown> | null> => {
    try {
      const data = await window.electronAPI?.configRead?.(name)
      if (data === null || data === undefined) return null
      // 主进程 config-read 已返回解析后的对象，直接使用
      return data as StorageValue<unknown>
    } catch {
      return null
    }
  },

  setItem: (name: string, value: StorageValue<unknown>): void => {
    try {
      // JSON round-trip 过滤函数、undefined 等不可 IPC 序列化的值
      const safe = JSON.parse(JSON.stringify(value))
      window.electronAPI?.configWrite?.(name, safe)
    } catch (err) {
      console.error(`[fileStorage] setItem("${name}") failed:`, err)
    }
  },

  removeItem: (name: string): void => {
    try {
      window.electronAPI?.configWrite?.(name, null)
    } catch (err) {
      console.error(`[fileStorage] removeItem("${name}") failed:`, err)
    }
  },
}
