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
import { broadcastToAllWindows } from '../utils/windowBroadcast'
import type { CapabilityFilter, CapabilityType } from './types'

/** capabilityHub.onChanged 订阅的注销句柄（供 will-quit 释放） */
let unsubscribeCapabilityChanged: (() => void) | null = null

/** 注销 CapabilityHub → 渲染进程的变更订阅（幂等；will-quit 调用） */
export function disposeCapabilityIPC(): void {
    unsubscribeCapabilityChanged?.()
    unsubscribeCapabilityChanged = null
}

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

    // ── 变更通知（Hub → 渲染进程）──
    // 写入唯一入口为 capabilityHub.replaceAll（由 powerManager.refresh 调用）。
    // Hub 检测到投影变化时 emit { seq }，这里广播给所有窗口，消费端整表重取。
    // 先注销旧订阅再重订阅：重复 register 时不残留句柄
    unsubscribeCapabilityChanged?.()
    unsubscribeCapabilityChanged = capabilityHub.onChanged(({ seq }) => {
        broadcastToAllWindows('capability:changed', { seq })
    })
}
