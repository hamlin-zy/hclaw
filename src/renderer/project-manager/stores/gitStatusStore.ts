// src/renderer/project-manager/stores/gitStatusStore.ts
import {create} from 'zustand'
import type {GitStatus, GitStatusSummary} from '@shared/types/project-manager'

interface GitStatusStore {
  /** 当前 summary 归属的 workspace（切仓库时用于丢弃陈旧响应/推送） */
  ws: string | null
  /** 请求代际：每次 refresh 自增，落地前比对以丢弃被后续请求覆盖的响应 */
  generation: number
  summary: GitStatusSummary | null
  loading: boolean
  /** refs 重载信号：commit/push 后自增，驱动分支树与 Git 区头部重新拉取（spec §4.4） */
  refsVersion: number
  bumpRefs(): void
  refresh(ws: string): Promise<void>
  applyPushed(ws: string, summary: GitStatusSummary): void
  grouped(): {modified: GitStatus[], added: GitStatus[], deleted: GitStatus[], renamed: GitStatus[], untracked: GitStatus[]}
}

export const useGitStatusStore = create<GitStatusStore>()((set, get) => ({
  ws: null,
  generation: 0,
  summary: null,
  loading: false,
  refsVersion: 0,
  async refresh(ws) {
    const gen = get().generation + 1
    set({ws, generation: gen, loading: true})
    try {
      const summary = await window.electronAPI?.projectManager.gitStatus(ws)
      // 归属/代际校验：期间切了仓库或有更新的 refresh 发出 → 丢弃陈旧响应
      if (get().ws !== ws || get().generation !== gen) return
      set({summary})
    } finally {
      if (get().ws === ws && get().generation === gen) set({loading: false})
    }
  },
  applyPushed(ws, summary) {
    const cur = get().ws
    // 归属校验：非当前 workspace 的推送直接丢弃，防止旧仓库 summary 覆盖新仓库
    if (cur !== null && cur !== ws) return
    set({ws, summary})
  },
  bumpRefs() { set(s => ({refsVersion: s.refsVersion + 1})) },
  grouped() {
    const s = get().summary
    const buckets = {modified: [] as GitStatus[], added: [] as GitStatus[], deleted: [] as GitStatus[], renamed: [] as GitStatus[], untracked: [] as GitStatus[]}
    if (!s) return buckets
    for (const st of Object.values(s.statusMap)) {
      if (st.status === '??') buckets.untracked.push(st)
      else if (st.status === 'M') buckets.modified.push(st)
      else if (st.status === 'A') buckets.added.push(st)
      else if (st.status === 'D') buckets.deleted.push(st)
      else if (st.status === 'R') buckets.renamed.push(st)
    }
    return buckets
  },
}))
