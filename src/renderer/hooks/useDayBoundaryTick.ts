import {useEffect, useState} from 'react'

/**
 * useDayBoundaryTick - 跨天（本地午夜）自动刷新信号
 *
 * 背景：会话/备忘录列表的日期分组（日/月/年）在渲染时用 Date.now() 现算，
 * 组件长期挂载时跨天后分组（"今天"等）不会自动刷新。本 hook 返回一个
 * 每逢跨天自增的 tick 计数，消费方把它加进 useMemo 依赖即可触发重算。
 *
 * 设计理由：
 * - 不用 setInterval：无需周期轮询，午夜只需触发一次；用 setTimeout 精确
 *   对齐下一个本地 00:00:00（+1s 缓冲，避免边界竞争），触发后递归重挂
 *   （重新计算到下一个午夜的延迟，天然覆盖跨年/跨月等任意间隔）。
 * - 监听 document visibilitychange 兜底：休眠/最小化时浏览器会节流或暂停
 *   定时器，可能错过午夜；页面重新可见时立即 +1 并重新对齐下一次午夜，
 *   保证恢复后分组必然正确。
 */

/** 计算距下一个本地午夜（明天 00:00:00）的毫秒数 */
export function msToNextMidnight(now: number): number {
    const d = new Date(now)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0)
    return next.getTime() - now
}

/** 返回跨天信号 tick：每过一个本地午夜（或页面从后台恢复）自增 1 */
export function useDayBoundaryTick(): number {
    const [tick, setTick] = useState(0)

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>

        // 精确对齐下一个本地午夜（+1s 缓冲），触发后递归重挂覆盖任意间隔（含跨年）
        const arm = () => {
            timer = setTimeout(() => {
                setTick((t) => t + 1)
                arm()
            }, msToNextMidnight(Date.now()) + 1000)
        }
        arm()

        // 兜底：休眠/最小化期间定时器可能被节流错过午夜，恢复可见时强制刷新并重新对齐
        const onVisible = () => {
            if (document.visibilityState !== 'visible') return
            clearTimeout(timer)
            setTick((t) => t + 1)
            arm()
        }
        document.addEventListener('visibilitychange', onVisible)

        return () => {
            clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisible)
        }
    }, [])

    return tick
}
