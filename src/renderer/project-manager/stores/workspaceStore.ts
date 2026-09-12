// src/renderer/project-manager/stores/workspaceStore.ts
import {create} from 'zustand'

interface WorkspaceStore {
  workspacePath: string
}

export const useWorkspaceStore = create<WorkspaceStore>()(() => ({
  // 惰性读取：electronAPI 预载时序不定（含测试 beforeEach 注入 mock 的场景），读取时才取值
  get workspacePath() {
    return window.electronAPI?.projectManager?.workspacePath ?? ''
  },
}))
