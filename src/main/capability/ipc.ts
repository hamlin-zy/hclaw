/**
 * CapabilityHub IPC Handlers
 *
 * 注册统一能力中心的 IPC handler，供渲染进程查询。
 *
 * 设计原则：
 *   - 每个 handler 返回 CapabilityEntry[]（可序列化的纯对象数组）
 *   - 不做任何业务逻辑——业务逻辑在前端（过滤/排序/分组在 UI 层）
 *   - 所有 IPC 调用都是纯内存读取，无磁盘 IO
 *   - 列表类出口默认**不外发能力正文**（`content`，技能正文/系统提示可达数十 KB），
 *     确需正文的调用方显式传 `withContent: true`
 *
 * 正文裁剪的落点是**传输层**，不是投影层：CapabilityHub 的只读投影接口一字未动
 * （其写 seam 已被静态契约测试锁死为单次 replaceAll，见
 * tests/main/capability/capabilityChangedBroadcast.test.ts）。
 */

import { ipcMain } from 'electron'
import { capabilityHub } from './CapabilityHub'
import { broadcastToAllWindows } from '../utils/windowBroadcast'
import type { CapabilityEntry, CapabilityFilter, CapabilityType } from './types'

/** capabilityHub.onChanged 订阅的注销句柄（供 will-quit 释放） */
let unsubscribeCapabilityChanged: (() => void) | null = null

/** 列表类出口的可选参数：`withContent` 缺省即裁剪正文 */
export interface CapabilityQueryOptions {
    withContent?: boolean
}

/**
 * 传输裁剪：按需剔除 `content` 字段（整键移除，不留 `undefined` 占位）。
 *
 * 只裁剪正文：`searchText`（name+description 预拼接，小体量）等投影字段原样保留，
 * 保证消费端不必为了搜索再取一次。
 */
function applyContentPolicy(entries: CapabilityEntry[], withContent?: boolean): CapabilityEntry[] {
    if (withContent) return entries
    return entries.map(entry => {
        if (entry.content === undefined) return entry
        const { content: _content, ...rest } = entry
        return rest
    })
}

/** 注销 CapabilityHub → 渲染进程的变更订阅（幂等；will-quit 调用） */
export function disposeCapabilityIPC(): void {
    unsubscribeCapabilityChanged?.()
    unsubscribeCapabilityChanged = null
}

/** 注册所有 CapabilityHub 的 IPC handlers */
export function registerCapabilityIPC(): void {
    // ── 通用查询（列表类出口）──
    ipcMain.handle('capability:query', (_event, filter: CapabilityFilter = {}, options: CapabilityQueryOptions = {}) => {
        return applyContentPolicy(capabilityHub.query(filter), options?.withContent)
    })

    // ── 按类型获取（列表类出口）──
    ipcMain.handle('capability:get-by-type', (_event, type: CapabilityType, options: CapabilityQueryOptions = {}) => {
        return applyContentPolicy(capabilityHub.getByType(type), options?.withContent)
    })

    // ── 搜索（Ctrl+K，列表类出口）─
    ipcMain.handle('capability:search', (_event, query: string, options: CapabilityQueryOptions = {}) => {
        return applyContentPolicy(capabilityHub.search(query), options?.withContent)
    })

    // ── 插件分组（列表类出口；分组内的 entries 同样受正文裁剪）──
    ipcMain.handle('capability:plugin-groups', (_event, type?: CapabilityType, options: CapabilityQueryOptions = {}) => {
        return capabilityHub.getPluginGroups(type).map(group => ({
            ...group,
            entries: applyContentPolicy(group.entries, options?.withContent),
        }))
    })

    // ── 统计 ──
    ipcMain.handle('capability:stats', () => {
        return capabilityHub.getStats()
    })

    // ── 单个条目 ──
    // 单条「详情」出口（非列表），语义上就是「要这一条的完整内容」，故不做默认裁剪；
    // 需要裁剪时显式传 withContent: false。
    ipcMain.handle('capability:get', (_event, id: string, options: CapabilityQueryOptions = {}) => {
        const entry = capabilityHub.get(id)
        if (!entry) return null
        return applyContentPolicy([entry], options?.withContent ?? true)[0]
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
