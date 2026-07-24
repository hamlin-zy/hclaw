/**
 * 更新状态全局 store
 *
 * 数据流：
 *   main process → IPC 推送 → App.tsx useEffect → setResult
 *   AboutDialog / MenuBar → useUpdaterStore selector 订阅
 *
 * 会话级状态（不持久化，重启后自动重置）：
 *   - ignored: 用户点了「稍后更新」（本次会话不再弹）
 *   - alreadyNoticed: 启动期间已经弹出过一次（防止同一会话内重复弹）
 */

import { create } from 'zustand'
import type { UpdateResult } from '../../shared/types/updater'

interface UpdaterState {
  /** 当前最新一次检查结果（null 表示尚未检查） */
  result: UpdateResult | null
  /** 用户主动点击「检查更新」时的 loading 状态（与静默检查独立） */
  loading: boolean
  /** 用户点了「稍后更新」 — 本次会话不再弹更新通知 */
  ignored: boolean
  /** 本次会话内已经弹出过一次更新通知（防止同会话内重复弹） */
  alreadyNoticed: boolean

  setResult: (result: UpdateResult | null) => void
  setLoading: (loading: boolean) => void
  /** 用户点了「稍后更新」 — 标记 ignored 并关闭弹窗 */
  setIgnored: () => void
  /** 弹窗成功展示后调用，标记 alreadyNoticed 防止重复弹 */
  markShownOnce: () => void
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  result: null,
  loading: false,
  ignored: false,
  alreadyNoticed: false,

  setResult: (result) =>
    set((s) => {
      // 当收到新的 update-available 且之前没有弹出过 → 重置 alreadyNoticed
      // 让用户主动点"检查更新"也能再次触发弹窗
      if (
        result?.status === 'update-available' &&
        s.result?.latestVersion !== result.latestVersion
      ) {
        return { result, alreadyNoticed: false }
      }
      return { result }
    }),
  setLoading: (loading) => set({ loading }),
  setIgnored: () => set({ ignored: true, alreadyNoticed: true }),
  markShownOnce: () => set({ alreadyNoticed: true }),
}))