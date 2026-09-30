import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {sqliteStorage} from '../lib/sqliteStorage'
import {SIDEBAR_STATE_CONFIG_KEY} from '../../shared/configKeys'

/** 左侧边栏可调宽度边界（px）。
 *  ★ 下限 2026-09-30 由 180 提到 300：会话行右侧是固定列（项目 chip + 状态徽章 +
 *    时间 52px 槽 + 图钉 10px 槽），180–240 宽下留给标题的只剩几十像素。
 *    副作用：widthTier 的 tight 档（<270）在当前下限下不可达，保留为降级档待下限回调。 */
export const SIDEBAR_MIN_WIDTH = 300
export const SIDEBAR_MAX_WIDTH = 480
export const SIDEBAR_DEFAULT_WIDTH = 320

interface SidebarStore {
    leftCollapsed: boolean
    /** 左侧边栏展开态宽度（px）。折叠态走内联 fallback 36px，与本字段无关 */
    leftWidth: number
    /** 一次性标志：拖拽提交宽度时置位，ConversationSidebar 消费后立即清除。
     *  拖拽期 DOM 已被直改到终值，framer-motion 不知情会从内部旧值重播宽度动画
     *  （展开方向可见抖动），故这次渲染必须跳过宽度动画 */
    suppressLeftWidthAnimation: boolean
    setLeftWidth: (width: number) => void
    toggleLeft: () => void
    setLeftCollapsed: (collapsed: boolean) => void
    rightCollapsed: boolean
    toggleRight: () => void
    setRightCollapsed: (collapsed: boolean) => void
    /** 最近会话区固定高度（px）。null = 自然高度（由内容撑开）；仅拖拽提交后为数值 */
    recentHeight: number | null
    setRecentHeight: (height: number | null) => void
    /** 消费一次性动画抑制标志（下帧渲染恢复正常动画） */
    clearLeftWidthAnimationSuppress: () => void
}

/** 持久化子集（partialize） */
type PersistedSidebar = Pick<SidebarStore, 'leftWidth' | 'leftCollapsed' | 'rightCollapsed' | 'recentHeight'>

export const useSidebarStore = create<SidebarStore>()(
    // 第四个泛型 = partialized 类型（与 partialize 返回一致），使 storage 泛型可对齐
    persist<SidebarStore, [], [], PersistedSidebar>(
        (set) => ({
            leftCollapsed: false,
            leftWidth: SIDEBAR_DEFAULT_WIDTH,
            suppressLeftWidthAnimation: false,
            setLeftWidth: (width) => {
                set({
                    leftWidth: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width))),
                    // 唯一调用点是拖拽手柄的 mouseup 提交（App.tsx SidebarResizeHandle）
                    suppressLeftWidthAnimation: true,
                })
            },
            toggleLeft: () => {
                set((state) => ({leftCollapsed: !state.leftCollapsed}))
            },
            setLeftCollapsed: (collapsed) => {
                set({leftCollapsed: collapsed})
            },
            rightCollapsed: false,
            toggleRight: () => {
                set((state) => ({rightCollapsed: !state.rightCollapsed}))
            },
            setRightCollapsed: (collapsed) => {
                set({rightCollapsed: collapsed})
            },
            recentHeight: null,
            setRecentHeight: (height) => {
                set({recentHeight: height === null ? null : Math.round(height)})
            },
            clearLeftWidthAnimationSuppress: () => {
                if (useSidebarStore.getState().suppressLeftWidthAnimation) {
                    set({suppressLeftWidthAnimation: false})
                }
            },
        }),
        {
            name: SIDEBAR_STATE_CONFIG_KEY,
            storage: sqliteStorage as unknown as PersistStorage<PersistedSidebar>,
            version: 1,
            // 只持久化宽度与折叠布尔；函数字段不可序列化，持久化它们没有意义
            partialize: (s) => ({
                leftWidth: s.leftWidth,
                leftCollapsed: s.leftCollapsed,
                rightCollapsed: s.rightCollapsed,
                recentHeight: s.recentHeight,
            }),
            // 恢复时按当前边界钳制：下限上调（180 → 300）后，历史落盘值（如 180/240）
            // 若不钳，会绕过 setLeftWidth 的 clamp 原样呈现 —— 「最小 300」只对新拖拽生效。
            merge: (persisted, current) => {
                const p = (persisted ?? {}) as Partial<PersistedSidebar>
                return {
                    ...current,
                    ...p,
                    leftWidth: typeof p.leftWidth === 'number'
                        ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(p.leftWidth)))
                        : current.leftWidth,
                }
            },
        },
    ),
)
