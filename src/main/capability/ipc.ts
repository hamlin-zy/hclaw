/**
 * CapabilityHub IPC Handlers
 *
 * 注册统一能力中心的 IPC handler，供渲染进程查询。
 *
 * 设计原则：
 *   - 每个 handler 返回 CapabilityEntry[]（可序列化的纯对象数组）
 *   - 不做任何业务逻辑——业务逻辑在前端（过滤/排序/分组在 UI 层）
 *   - 所有 IPC 调用都是纯内存读取，无磁盘 IO
 */

import { ipcMain } from 'electron'
import { capabilityHub } from './CapabilityHub'
import type { CapabilityFilter, CapabilityType } from './types'

/** 注册所有 CapabilityHub 的 IPC handlers */
export function registerCapabilityIPC(): void {
    // ── 通用查询 ──
    ipcMain.handle('capability:query', (_event, filter: CapabilityFilter = {}) => {
        return capabilityHub.query(filter)
    })

    // ── 按类型获取 ──
    ipcMain.handle('capability:get-by-type', (_event, type: CapabilityType) => {
        return capabilityHub.getByType(type)
    })

    // ── 搜索（Ctrl+K）─
    ipcMain.handle('capability:search', (_event, query: string) => {
        return capabilityHub.search(query)
    })

    // ── 插件分组 ──
    ipcMain.handle('capability:plugin-groups', (_event, type?: CapabilityType) => {
        return capabilityHub.getPluginGroups(type)
    })

    // ── 统计 ──
    ipcMain.handle('capability:stats', () => {
        return capabilityHub.getStats()
    })

    // ── 单个条目 ──
    ipcMain.handle('capability:get', (_event, id: string) => {
        return capabilityHub.get(id) ?? null
    })

    // ── 从外部模块调用的写入入口 ──
    // (预留: 由 powerManager、plugin IPC 等在 refresh 后调用)
    ipcMain.handle('capability:register-batch', (_event, entries: any[]) => {
        capabilityHub.registerBatch(entries)
        return { success: true, count: entries.length }
    })

    ipcMain.handle('capability:on-plugin-state-change', (_event, pluginName: string, enabled: boolean) => {
        capabilityHub.onPluginStateChange(pluginName, enabled)
        return { success: true }
    })

    ipcMain.handle('capability:clear', () => {
        capabilityHub.clear()
        return { success: true }
    })
}
