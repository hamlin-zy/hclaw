/**
 * useResetTimeout — 「重置式定时器」通用件
 *
 * 语义：每次调用（重新）安排一次 fn，仅最后一次生效——设置前先 clearTimeout 取消上一次，
 * 触发后把句柄置 null；卸载时清理定时器，避免悬空 timer 泄漏。
 */

import {useCallback, useEffect, useRef} from 'react'

export function useResetTimeout(): (fn: () => void, ms: number) => void {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current)
    }, [])

    return useCallback((fn: () => void, ms: number) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            timer.current = null
            fn()
        }, ms)
    }, [])
}
