/**
 * Hook IPC Handlers
 *
 * 提供 Hook 相关的 IPC 处理函数
 * 使用 SQLite 数据库持久化存储
 */

import {ipcMain} from 'electron'
import type {HookDefinition} from '../../config/hookConfig'
import {deletePluginHooks, readHookConfig, syncPluginHooks, writeHookConfig} from '../../config/hookConfig'
import {getAllHookEvents} from './definitions'
import {PluginRegistry} from '../registry'
import {eventBus, PluginEvents} from '../../common/eventBus'
import {createLogger} from '../../agent/logger'

const logger = createLogger('hooks')

/**
 * 注册 Hook 相关的 IPC handlers
 */
export function registerHookIPC(): void {
  // 获取所有 Hooks（读取 JSON 配置，插件 hooks 仅在首次安装时同步）
  ipcMain.handle('hooks:list', async () => {
    try {
        return readHookConfig()
    } catch (err) {
      console.error('[hooks:list] error:', err)
      return []
    }
  })

  // 获取单个 Hook
  ipcMain.handle('hooks:get', async (_event, id: string) => {
      return readHookConfig().find(h => h.id === id) || null
  })

  // 保存 Hook
  ipcMain.handle('hooks:save', async (_event, hook: any) => {
    try {
      const now = Date.now()

      // 解析 events：如果是字符串则解析为数组
      let events = hook.events
      if (typeof events === 'string') {
        try {
          events = JSON.parse(events)
        } catch {
          events = [events]
        }
      }
      if (!Array.isArray(events)) {
        events = []
      }

      // 解析 config：如果是字符串则解析为对象
      let config = hook.config
      if (typeof config === 'string') {
        try {
          config = JSON.parse(config)
        } catch {
          config = {}
        }
      }

      const data = {
        id: hook.id,
        name: hook.name,
        description: hook.description || '',
        events,
        config: config || {},
        enabled: hook.enabled ?? true,
        source: hook.source || 'user',
        pluginName: hook.pluginName,
        createdAt: hook.createdAt || now,
        updatedAt: now,
      }

        const hooks = readHookConfig()
        const idx = hooks.findIndex(h => h.id === data.id)
        if (idx >= 0) hooks[idx] = data as HookDefinition
        else hooks.push(data as HookDefinition)
        const success = writeHookConfig(hooks)
      return { success }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // 删除 Hook
  ipcMain.handle('hooks:delete', async (_event, id: string) => {
    try {
        const hooks = readHookConfig()
        const filtered = hooks.filter(h => h.id !== id)
        const success = writeHookConfig(filtered)
      return { success }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // 设置 Hook 启用状态
  ipcMain.handle('hooks:set-enabled', async (_event, id: string, enabled: boolean) => {
    try {
        const hooks = readHookConfig()
        const hook = hooks.find(h => h.id === id)
      if (!hook) {
        return { success: false, error: 'Hook not found' }
      }

        hook.enabled = enabled
        hook.updatedAt = Date.now()
        const success = writeHookConfig(hooks)
      return { success }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // 获取所有事件定义
  ipcMain.handle('hooks:get-event-definitions', async () => {
    return getAllHookEvents()
  })

  // 获取插件 hook 的原始默认配置（用于还原）
  ipcMain.handle('hooks:get-plugin-defaults', async (_event, pluginName: string, hookId: string) => {
    try {
      const registry = PluginRegistry.getInstance()
      const pluginHooks = registry.getHooks()
      const hooks = pluginHooks.get(pluginName)
      if (!hooks) return null
      // 匹配 id；若 plugin 未显式设置 id，则回退到组合 id 匹配
      return hooks.find(h => {
        const computedId = h.id || `${pluginName}-${h.type}-${h.matcher || 'default'}`
        return computedId === hookId
      }) || null
    } catch (err) {
      console.error('[hooks:get-plugin-defaults] error:', err)
      return null
    }
  })

  // 监听插件事件，同步 hooks
  eventBus.on(PluginEvents.INSTALLED, (pluginPath: string) => {
    const registry = PluginRegistry.getInstance()
    // 查找安装的插件
    for (const [name, plugin] of registry.getAll().map(p => [p.name, p] as [string, any])) {
      if (plugin.path === pluginPath && plugin.hooks && plugin.hooks.length > 0) {
        logger.info('Syncing plugin hooks to database', { plugin: name, count: plugin.hooks.length })
          syncPluginHooks(name, plugin.hooks.map((hook: any) => ({
          id: hook.id || `${name}-${hook.type}-${hook.matcher || 'default'}`,
          name: hook.name || `${hook.type} hook`,
          description: hook.description || '',
          events: hook.events || [],
          config: hook as unknown as Record<string, unknown>,
        })))
      }
    }
  })

  eventBus.on(PluginEvents.UNINSTALLED, (pluginName: string) => {
    logger.info('Removing plugin hooks from database', { plugin: pluginName })
      deletePluginHooks(pluginName)
  })

  logger.info('Hook IPC registered')
}
