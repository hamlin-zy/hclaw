// src/renderer/project-manager/stores/fileTreeStore.ts
import {create} from 'zustand'
import type {DirEntry} from '@shared/types/project-manager'
import {registerMemorySource} from '../../utils/memoryWatermark'
import {applyMultiSelect} from '../lib/multiSelect'

export const CACHE_LIMIT = 500   // 目录缓存 LRU 上限（大仓全量展开防常驻数十 MB）

interface FileTreeStore {
  /** 当前缓存归属的 workspace；缓存键仍是相对路径，切 ws 时整体失效 */
  ws: string | null
  expanded: Set<string>
  childrenCache: Record<string, DirEntry[]>
  cacheOrder: string[]            // LRU 访问序（尾部最新）
  selectedPath: string | null
  /** 多选集合（Ctrl/Shift 选区）；selectedPath 是其主选 */
  selectedPaths: Set<string>
  /** Shift 区间锚点 */
  anchorPath: string | null
  selectWithMods(path: string, order: string[], mods: {ctrl?: boolean; shift?: boolean}): void
  setWorkspace(ws: string): void
  toggleExpand(path: string): void
  setChildren(path: string, entries: DirEntry[], ownerWs?: string): void
  /** 批量写入（全展用）：单次提交，避免逐目录提交触发上百次全树重渲 */
  setChildrenBulk(entries: Record<string, DirEntry[]>, ownerWs?: string): void
  getChildren(path: string): DirEntry[] | undefined
  invalidateFrom(path: string): void
  /** 外部变更失效计数；FileTree 订阅它触发「补齐被清掉的目录」重载（见 invalidateFrom） */
  invalidateTick: number
  select(path: string | null): void
  /** 定位请求目标（POSIX 相对路径）。触发方只写它，FileTree 订阅后执行展开 + 选中 + 滚动（spec §3.1） */
  revealTarget: string | null
  requestReveal(path: string): void
  clearReveal(): void
}

export const useFileTreeStore = create<FileTreeStore>()((set, get) => ({
  ws: null,
  expanded: new Set(),
  childrenCache: {},
  cacheOrder: [],
  selectedPath: null,
  selectedPaths: new Set(),
  anchorPath: null,
  revealTarget: null,
  invalidateTick: 0,
  setWorkspace(ws) {
    if (get().ws === ws) return
    // 跨 workspace：整体失效目录缓存，同时清掉残留的定位请求与选中态
    set({ws, childrenCache: {}, cacheOrder: [], revealTarget: null, selectedPath: null, selectedPaths: new Set(), anchorPath: null})
  },
  toggleExpand(path) {
    const next = new Set(get().expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    set({expanded: next})
  },
  setChildren(path, entries, ownerWs) {
    // 归属校验：异步响应落地前比对发出请求时的 workspace，不一致（期间切了仓库）直接丢弃
    if (ownerWs !== undefined && get().ws !== ownerWs) return
    set(s => {
      const cache = {...s.childrenCache, [path]: entries}
      const order = [...s.cacheOrder.filter(p => p !== path), path]
      // LRU 淘汰最久未访问
      while (order.length > CACHE_LIMIT) {
        const evict = order.shift()!
        delete cache[evict]
      }
      return {childrenCache: cache, cacheOrder: order}
    })
  },
  setChildrenBulk(entries, ownerWs) {
    // 归属校验同 setChildren
    if (ownerWs !== undefined && get().ws !== ownerWs) return
    const paths = Object.keys(entries)
    if (paths.length === 0) return   // 无新增：不写新引用，避免一次空重渲
    set(s => {
      // 用展开语法而非逐键赋值：路径恰为 '__proto__' 时仍写成自有属性
      const cache = {...s.childrenCache, ...entries}
      const incoming = new Set(paths)
      const order = [...s.cacheOrder.filter(p => !incoming.has(p)), ...paths]   // 批量路径统一移到 LRU 尾部
      while (order.length > CACHE_LIMIT) {
        const evict = order.shift()!
        delete cache[evict]
      }
      return {childrenCache: cache, cacheOrder: order}
    })
  },
  getChildren(path) {
    const hit = get().childrenCache[path]
    if (hit !== undefined) {
      // 刷新 LRU 访问序
      set(s => ({cacheOrder: [...s.cacheOrder.filter(p => p !== path), path]}))
    }
    return hit
  },
  invalidateFrom(path) {
    // 前缀匹配失效（pm:file-changed 到达时调用）
    set(s => {
      const cache: Record<string, DirEntry[]> = {}
      const order = s.cacheOrder.filter(p => {
        if (p === path || p.startsWith(path + '/')) return false
        cache[p] = s.childrenCache[p]!
        return true
      })
      return {childrenCache: cache, cacheOrder: order, invalidateTick: s.invalidateTick + 1}
    })
  },
  select(path) {
    set(path === null
      ? {selectedPath: null, selectedPaths: new Set(), anchorPath: null}
      : {selectedPath: path, selectedPaths: new Set([path]), anchorPath: path})
  },
  selectWithMods(path, order, mods) {
    const r = applyMultiSelect({selected: get().selectedPaths, anchor: get().anchorPath}, path, order, mods)
    set({selectedPaths: r.selected, anchorPath: r.anchor, selectedPath: r.main})
  },
  requestReveal(path) { set({revealTarget: path}) },
  clearReveal() { set({revealTarget: null}) },
}))

registerMemorySource('fileTree', () => {
  const s = useFileTreeStore.getState()
  return {cachedDirs: Object.keys(s.childrenCache).length}
})
