// src/renderer/project-manager/stores/editorTabStore.ts
import {create} from 'zustand'
import type {DiffResult} from '@shared/types/project-manager'
import {registerMemorySource} from '../../utils/memoryWatermark'

const CONTENT_EVICTION_LIMIT = 2 * 1024 * 1024   // 非激活非 pinned tab 的 content 淘汰阈值（08-16 内存治理经验）
const DIFF_EVICTION_LIMIT = CONTENT_EVICTION_LIMIT   // diffData 与 file content 同粒度（oldContent + newContent 合计）

export interface EditorTabState {
  id: string
  type: 'file' | 'diff'
  filePath?: string
  diffType?: 'working-tree' | 'commit'
  ref?: string
  title: string
  statusBadge?: 'M' | 'A' | 'D' | 'R' | '??'
  pinned: boolean
  content?: string
  diffData?: DiffResult
  fileHash?: string
  size?: number            // 文件字节数（1-5MB 区间 EditorArea 按 size 判 forceVim 用）
  externalChangeDetected: boolean
}

interface OpenFileInput { path: string, title: string, content: string, hash: string, size?: number, statusBadge?: EditorTabState['statusBadge'] }
interface OpenDiffInput { filePath: string, title: string, diffType: 'working-tree' | 'commit', ref?: string, diffData: DiffResult }

interface EditorTabStore {
  tabs: EditorTabState[]
  activeTabId: string | null
  openFileTab(input: OpenFileInput): void
  openDiffTab(input: OpenDiffInput): void
  closeTab(id: string): void
  closeOther(id: string): void
  closeAll(): void
  closeLeft(id: string): void
  closeRight(id: string): void
  pin(id: string): void
  setActive(id: string): void
  reloadTabContent(id: string, content: string, hash: string): void
}

let seq = 0
const nextId = () => `tab-${++seq}`

// ---- 内存淘汰辅助（不进入 state，避免污染对外 API 形状）----

const diffBytes = (t: EditorTabState): number =>
  t.diffData ? t.diffData.oldContent.length + t.diffData.newContent.length : 0

export const useEditorTabStore = create<EditorTabStore>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFileTab(input) {
    const found = get().tabs.find(t => t.type === 'file' && t.filePath === input.path)
    if (found) { get().setActive(found.id); return }   // 走 setActive 以触发淘汰
    const tab: EditorTabState = {id: nextId(), type: 'file', filePath: input.path, title: input.title, statusBadge: input.statusBadge, pinned: false, content: input.content, fileHash: input.hash, size: input.size, externalChangeDetected: false}
    set(s => ({tabs: [...s.tabs, tab]}))
    get().setActive(tab.id)
  },

  openDiffTab(input) {
    const found = get().tabs.find(t => t.type === 'diff' && t.filePath === input.filePath && t.ref === input.ref)
    if (found) {
      // diffData 可能已被内存淘汰：用本次按需拉取的数据回填，保证激活后不出现空白面板
      if (found.diffData === undefined && input.diffData) {
        set(s => ({tabs: s.tabs.map(t => (t.id === found.id ? {...t, diffData: input.diffData} : t))}))
      }
      get().setActive(found.id); return
    }
    const tab: EditorTabState = {id: nextId(), type: 'diff', filePath: input.filePath, diffType: input.diffType, ref: input.ref, title: input.title, pinned: false, diffData: input.diffData, externalChangeDetected: false}
    set(s => ({tabs: [...s.tabs, tab]}))
    get().setActive(tab.id)   // 走 setActive 以触发淘汰
  },

  closeTab(id) {
    set(s => {
      const tabs = s.tabs.filter(t => t.id !== id)
      return {tabs, activeTabId: s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId}
    })
  },

  closeOther(id) {
    // 保留目标 tab、pinned tab 及当前激活 tab（行为以测试 closeOther 保留 pinned 与自身 为准）
    set(s => ({tabs: s.tabs.filter(t => t.id === id || t.pinned || t.id === s.activeTabId)}))
  },

  closeAll() {
    set({tabs: [], activeTabId: null})
  },

  closeLeft(id) {
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === id)
      if (idx === -1) return s
      return {tabs: s.tabs.filter((t, i) => i >= idx || t.pinned)}
    })
  },

  closeRight(id) {
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === id)
      if (idx === -1) return s
      return {tabs: s.tabs.filter((t, i) => i <= idx || t.pinned)}
    })
  },

  pin(id) {
    set(s => {
      const target = s.tabs.find(t => t.id === id)
      if (!target) return s
      // 翻转 pinned 标记，并按 [pinned..., unpinned...] 稳定重排
      const updated = s.tabs.map(t => (t.id === id ? {...t, pinned: !t.pinned} : t))
      const pinned = updated.filter(t => t.pinned)
      const unpinned = updated.filter(t => !t.pinned)
      return {tabs: [...pinned, ...unpinned]}
    })
  },

  setActive(id) {
    set(s => {
      const active = s.tabs.find(t => t.id === id)
      if (!active) return s
      // 非激活、非 pinned、同粒度超阈值 → 释放大内容；激活时由按需加载路径回填
      const evictContent = (t: EditorTabState) =>
        !t.pinned && t.id !== id && t.type === 'file' && t.content !== undefined && t.content.length > CONTENT_EVICTION_LIMIT
      const evictDiff = (t: EditorTabState) =>
        !t.pinned && t.id !== id && t.type === 'diff' && t.diffData !== undefined && diffBytes(t) > DIFF_EVICTION_LIMIT
      const tabs = s.tabs.map(t => {
        if (evictContent(t)) return {...t, content: undefined}
        if (evictDiff(t)) return {...t, diffData: undefined}
        return t
      })
      return {activeTabId: id, tabs}
    })
  },

  reloadTabContent(id, content, hash) {
    set(s => {
      const isActive = s.activeTabId === id
      const isBig = content.length > CONTENT_EVICTION_LIMIT
      // 非激活 tab 且 content > 2MB：只更新 hash 不回填 content（保持淘汰闭环）
      if (!isActive && isBig) {
        return {tabs: s.tabs.map(t => (t.id === id ? {...t, fileHash: hash} : t))}
      }
      return {tabs: s.tabs.map(t => (t.id === id ? {...t, content, fileHash: hash} : t))}
    })
  },
}))

// 内存水位指标（复用诊断基建）
registerMemorySource('editorTabs', () => {
  const {tabs} = useEditorTabStore.getState()
  return {
    count: tabs.length,
    contentBytes: tabs.reduce((sum, t) => sum + (t.content?.length ?? 0), 0),
    diffBytes: tabs.reduce((sum, t) => sum + diffBytes(t), 0),
  }
})
