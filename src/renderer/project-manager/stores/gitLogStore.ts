// src/renderer/project-manager/stores/gitLogStore.ts
import {create} from 'zustand'
import type {GitLogEntry, LogOptions} from '@shared/types/project-manager'
import {registerMemorySource} from '../../utils/memoryWatermark'
import {applyMultiSelect} from '../lib/multiSelect'

const PAGE_SIZE = 100
const MAX_LOG_ENTRIES = 2000   // 内存上限：防止长历史仓库无界翻页（10 万 commit ≈ 100MB）

/** 请求发起时的归属快照：ws 指明仓库，gen 单调递增标识请求序号 */
interface RequestSnapshot {ws: string, gen: number}

interface GitLogStore {
  /** 当前 entries/hasMore 归属的 workspace（切仓库时用于丢弃陈旧响应） */
  ws: string | null
  /** 请求代际：每次异步请求自增，落地前比对以丢弃被更新请求覆盖的响应 */
  generation: number
  entries: GitLogEntry[]
  selectedHash: string | null
  /** 多选集合（commit 列表 Ctrl/Shift）；selectedHash 是其主选 */
  selectedHashes: Set<string>
  /** Shift 区间锚点 */
  anchorHash: string | null
  selectWithMods(hash: string, order: string[], mods: {ctrl?: boolean; shift?: boolean}): void
  /** 当前过滤分支名（applyFilters 传入 filterBranch[0] 时写入；分支行选中态用） */
  selectedBranch: string | null
  /**
   * 待刷新增量标记：仓库 HEAD/refs 动了（外部 commit / push / 切分支），
   * 但用户当时不在列表顶部，先记着，待其滚到顶部再重取首屏。
   * 若不延迟，直接在用户翻到深处时重置 entries 会把列表内容悄悄换掉、打断阅读。
   */
  pendingHeadRefresh: boolean
  /** refs 变动 → 置位（不立即刷新）；消费见 GitDagGraph 滚到顶部时消费 */
  markHeadRefresh(): void
  /** 消费标记：返回 true 表示确有待刷新（调用方据此决定是否 loadInitial） */
  consumeHeadRefresh(): boolean
  loading: boolean
  hasMore: boolean
  lastOptions: LogOptions | null
  loadInitial(ws: string): Promise<void>
  loadMore(ws: string): Promise<void>
  applyFilters(ws: string, opts: LogOptions): Promise<void>
  select(hash: string | null): void
}

export const useGitLogStore = create<GitLogStore>()((set, get) => {
  /** 记录请求归属并自增代际，返回可在落地处比对的快照 */
  const beginRequest = (ws: string): RequestSnapshot => {
    const s = get()
    const gen = s.generation + 1
    // 切仓库时一并复位 loading：上一仓库在途的 loadMore 会被判陈旧而跳过 finally 复位，
    // 若此处不复位，loading 会永久卡住，导致新仓库无法再触底加载。
    if (s.ws !== ws) set({ws, generation: gen, loading: false})
    else set({ws, generation: gen})
    return {ws, gen}
  }
  /** 落地前校验：期间切了仓库或有更新的请求发出 → 陈旧，丢弃 */
  const isStale = (snap: RequestSnapshot): boolean => {
    const s = get()
    return s.ws !== snap.ws || s.generation !== snap.gen
  }

  return {
    ws: null,
    generation: 0,
    entries: [],
    selectedHash: null,
    selectedHashes: new Set(),
    anchorHash: null,
    selectedBranch: null,
    pendingHeadRefresh: false,
    loading: false,
    hasMore: true,
    lastOptions: null,

    markHeadRefresh() {
      set({pendingHeadRefresh: true})
    },
    consumeHeadRefresh() {
      if (!get().pendingHeadRefresh) return false
      set({pendingHeadRefresh: false})
      return true
    },

    async loadInitial(ws) {
      const opts = get().lastOptions ?? {limit: PAGE_SIZE}
      const snap = beginRequest(ws)
      const entries = await window.electronAPI?.projectManager.gitLog(ws, opts) ?? []
      if (isStale(snap)) return
      // 重取首屏即已包含最新提交 → 待刷新标记被本次刷新吸收，一并清掉
      set({entries, hasMore: entries.length === PAGE_SIZE, lastOptions: opts, pendingHeadRefresh: false})
    },

    async loadMore(ws) {
      const {entries, hasMore, lastOptions, loading} = get()
      if (!hasMore || loading || !lastOptions) return
      const snap = beginRequest(ws)
      set({loading: true})
      try {
        const more = await window.electronAPI?.projectManager.gitLog(ws, {...lastOptions, skip: entries.length}) ?? []
        if (isStale(snap)) return
        const merged = [...entries, ...more]
        // 超限从尾部（更早侧）淘汰，保持 hasMore 供再次上滚重取
        const trimmed = merged.length > MAX_LOG_ENTRIES ? merged.slice(0, MAX_LOG_ENTRIES) : merged
        // 达到内存上限时置 hasMore:false（防止触顶死循环，引导用户缩小过滤范围）
        const atCap = trimmed.length >= MAX_LOG_ENTRIES
        set({entries: trimmed, hasMore: atCap ? false : more.length === PAGE_SIZE})
      } finally {
        // loadMore 有 loading 互斥，同一时刻至多一个在途；陈旧者必被 loadInitial/applyFilters 覆盖，
        // 而后者不置 loading，故此处无条件复位安全，也不会误清新请求的 loading。
        set({loading: false})
      }
    },

    async applyFilters(ws, opts) {
      const snap = beginRequest(ws)
      const entries = await window.electronAPI?.projectManager.gitLog(ws, {...opts, limit: opts.limit ?? PAGE_SIZE}) ?? []
      if (isStale(snap)) return
      // 换分支/换过滤 = 换视角；清空选中，符合用户"重新开始浏览"的直觉
      set({
        entries,
        hasMore: entries.length === PAGE_SIZE,
        lastOptions: opts,
        selectedHash: null,
        selectedHashes: new Set(),
        anchorHash: null,
        selectedBranch: opts.filterBranch?.[0] ?? null,
        // 换过滤 = 重取视角，结果已是最新 → 待刷新标记无意义，清掉
        pendingHeadRefresh: false,
      })
    },

    select(hash) {
      set(hash === null
        ? {selectedHash: null, selectedHashes: new Set(), anchorHash: null}
        : {selectedHash: hash, selectedHashes: new Set([hash]), anchorHash: hash})
    },
    selectWithMods(hash, order, mods) {
      const r = applyMultiSelect({selected: get().selectedHashes, anchor: get().anchorHash}, hash, order, mods)
      set({selectedHashes: r.selected, anchorHash: r.anchor, selectedHash: r.main})
    },
  }
})

registerMemorySource('gitLog', () => {
  const {entries} = useGitLogStore.getState()
  return {count: entries.length}
})
