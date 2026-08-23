import {create} from 'zustand'

interface SidebarStore {
    leftCollapsed: boolean
    toggleLeft: () => void
    setLeftCollapsed: (collapsed: boolean) => void
}

export const useSidebarStore = create<SidebarStore>((set) => ({
    leftCollapsed: false,

    toggleLeft: () => {
        set((state) => ({leftCollapsed: !state.leftCollapsed}))
    },

    setLeftCollapsed: (collapsed) => {
        set({leftCollapsed: collapsed})
    },
}))
