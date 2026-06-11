import {create} from 'zustand'
import type {FileChange, FileChangeGroup} from '@shared/types'

interface FileChangeStore {
  fileChangeGroups: FileChangeGroup[]
  isPanelCollapsed: boolean
  selectedFileChange: FileChange | null
  diffModalOpen: boolean
    isTodoPanelCollapsed: boolean

  addFileChangeGroup: (group: Omit<FileChangeGroup, 'id'>) => void
  addFileChange: (groupId: string, change: Omit<FileChange, 'id'>) => void
  clearFileChanges: () => void
  togglePanel: () => void
  openDiffModal: (change: FileChange) => void
  closeDiffModal: () => void
    toggleTodoPanel: () => void
}

export const useFileChangeStore = create<FileChangeStore>((set) => ({
  fileChangeGroups: [],
  isPanelCollapsed: false,
  selectedFileChange: null,
  diffModalOpen: false,
    isTodoPanelCollapsed: false,

  addFileChangeGroup: (group) => {
    const newGroup: FileChangeGroup = { ...group, id: crypto.randomUUID() }
    set((state) => ({
      fileChangeGroups: [...state.fileChangeGroups, newGroup],
    }))
  },

  addFileChange: (groupId, change) => {
    const newChange: FileChange = { ...change, id: crypto.randomUUID() }
    set((state) => ({
      fileChangeGroups: state.fileChangeGroups.map((g) =>
        g.id === groupId ? { ...g, changes: [...g.changes, newChange] } : g
      ),
    }))
  },

  clearFileChanges: () => {
    set({ fileChangeGroups: [] })
  },

  togglePanel: () => {
    set((state) => ({ isPanelCollapsed: !state.isPanelCollapsed }))
  },

  openDiffModal: (change) => {
    set({ selectedFileChange: change, diffModalOpen: true })
  },

  closeDiffModal: () => {
    set({ diffModalOpen: false, selectedFileChange: null })
  },

    toggleTodoPanel: () => {
        set((state) => ({isTodoPanelCollapsed: !state.isTodoPanelCollapsed}))
    },
}))
