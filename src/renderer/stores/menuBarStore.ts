import { create } from 'zustand'
import type { MenuDialogType } from '@shared/types'

interface MenuBarStore {
  activeDialog: MenuDialogType
  dialogOrigin: { x: number; y: number } | null
  openDialog: (dialog: MenuDialogType, origin?: { x: number; y: number }) => void
  closeDialog: () => void
}

export const useMenuBarStore = create<MenuBarStore>((set) => ({
  activeDialog: null,
  dialogOrigin: null,

  openDialog: (dialog, origin) => {
    set({ activeDialog: dialog, dialogOrigin: origin ?? null })
  },

  closeDialog: () => {
    set({ activeDialog: null })
  },
}))
