import {create} from 'zustand'

interface SidebarStore {
    leftCollapsed: boolean
    rightCollapsed: boolean
    toggleLeft: () => void
    toggleRight: () => void
    setLeftCollapsed: (collapsed: boolean) => void
    setRightCollapsed: (collapsed: boolean) => void
}

export const useSidebarStore = create<SidebarStore>((set) => ({
    leftCollapsed: false,
    rightCollapsed: true,

    toggleLeft: () => {
        set((state) => ({leftCollapsed: !state.leftCollapsed}))
    },

    toggleRight: () => {
        set((state) => ({rightCollapsed: !state.rightCollapsed}))
    },

    setLeftCollapsed: (collapsed) => {
        set({leftCollapsed: collapsed})
    },

    setRightCollapsed: (collapsed) => {
        set({rightCollapsed: collapsed})
    },
}))
