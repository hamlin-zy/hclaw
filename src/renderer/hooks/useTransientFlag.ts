/**
 * useTransientFlag — 「瞬时标志」通用件
 *
 * 语义：trigger() 置 true，delayMs 后自动复位 false；重复触发先 clearTimeout
 * 再重排计时（仅最后一次生效）。卸载时清理定时器，避免悬空 timer 泄漏。
 *
 * 用于复制反馈 / 保存成功提示一类的「闪一下」状态（各调用点延时值可不同）。
 */

import {useCallback, useEffect, useRef, useState} from 'react'

export function useTransientFlag(delayMs: number): [boolean, () => void] {
    const [flag, setFlag] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current)
    }, [])

    const trigger = useCallback(() => {
        if (timer.current) clearTimeout(timer.current)
        setFlag(true)
        timer.current = setTimeout(() => {
            timer.current = null
            setFlag(false)
        }, delayMs)
    }, [delayMs])

    return [flag, trigger]
}
