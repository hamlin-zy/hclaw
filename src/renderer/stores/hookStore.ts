/**
 * Hook Store - Zustand
 *
 * 管理 Hooks 的状态和操作
 */

import { create } from 'zustand'

// ─── 类型定义 ─────────────────────────────────────

export interface HookConfig {
  type: 'command' | 'prompt' | 'http' | 'agent'
  command?: string
  prompt?: string
  url?: string
  method?: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
  body?: string
  shell?: 'bash' | 'powershell'
  timeout?: number
  once?: boolean
  async?: boolean
  matcher?: string
}

export interface Hook {
  id: string
  name: string
  description: string
  events: string[]
  config: HookConfig
  enabled: boolean
  source: 'builtin' | 'user' | 'plugin'
  pluginName?: string
  createdAt: number
  updatedAt: number
}

export interface HookEventDefinition {
  event: string
  name: string
  description: string
  category: 'session' | 'tool' | 'agent' | 'mcp' | 'file' | 'permission' | 'task' | 'response'
  supportedTypes: string[]
  supportsMatcher: boolean
  contextParams: string[]
}

interface HookStore {
  hooks: Hook[]
  eventDefinitions: HookEventDefinition[]
  loading: boolean
  error: string | null

  // Actions
  fetchHooks: () => Promise<void>
  fetchEventDefinitions: () => Promise<void>
  saveHook: (hook: Omit<Hook, 'createdAt' | 'updatedAt'>) => Promise<{ success: boolean; error?: string }>
  deleteHook: (id: string) => Promise<{ success: boolean; error?: string }>
  toggleHook: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
}

export const useHookStore = create<HookStore>((set, get) => ({
  hooks: [],
  eventDefinitions: [],
  loading: false,
  error: null,

  /**
   * 获取所有 Hooks
   */
  fetchHooks: async () => {
    set({ loading: true, error: null })
    try {
      const hooks = await window.electronAPI?.hooks?.list()
      set({ hooks: hooks || [], loading: false })
    } catch (err) {
      set({ error: String(err), loading: false })
    }
  },

  /**
   * 获取所有事件定义
   */
  fetchEventDefinitions: async () => {
    try {
      const definitions = await window.electronAPI?.hooks?.getEventDefinitions()
      set({ eventDefinitions: definitions || [] })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  /**
   * 保存 Hook
   */
  saveHook: async (hook) => {
    try {
      const result = await window.electronAPI?.hooks?.save(hook)
      if (result?.success) {
        await get().fetchHooks()
      }
      return result || { success: false, error: 'Unknown error' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },

  /**
   * 删除 Hook
   */
  deleteHook: async (id) => {
    try {
      const result = await window.electronAPI?.hooks?.delete(id)
      if (result?.success) {
        await get().fetchHooks()
      }
      return result || { success: false, error: 'Unknown error' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },

  /**
   * 切换 Hook 启用状态
   */
  toggleHook: async (id, enabled) => {
    try {
      const result = await window.electronAPI?.hooks?.setEnabled(id, enabled)
      if (result?.success) {
        await get().fetchHooks()
      }
      return result || { success: false, error: 'Unknown error' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}))
