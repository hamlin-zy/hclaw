import {useEffect, useRef, type DependencyList} from 'react'

/**
 * 能力变更订阅（CapabilityHub）
 *
 * 1. 挂载即 refetch()：补齐「订阅建立前已发生变化」的漏事件窗口；
 * 2. 订阅 window.electronAPI.capability.onCapabilityChanged（A 阶段暴露），
 *    事件到达时 refetch()；
 * 3. 卸载时 unsubscribe。
 *
 * refetch 经 ref 转发，避免调用方每次渲染传入新函数导致的重复订阅；
 * 重取时机由 deps 决定（缺省仅在挂载时）。
 */
export function useCapabilityRefresh(refetch: () => void | Promise<void>, deps: DependencyList = []): void {
    const refetchRef = useRef(refetch)
    refetchRef.current = refetch

    useEffect(() => {
        void refetchRef.current()

        const unsubscribe = window.electronAPI?.capability?.onCapabilityChanged?.(() => {
            void refetchRef.current()
        })

        return () => {
            unsubscribe?.()
        }
        // refetch 已由 ref 转发，不列入依赖；重取时机由调用方 deps 决定
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
}
