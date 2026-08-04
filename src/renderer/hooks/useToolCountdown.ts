/**
 * useToolCountdown — 工具调用执行倒计时 hook
 *
 * 依据 timeoutMs（执行超时时间）与 startedAt（开始时刻）计算剩余时间，
 * 每秒刷新一次。仅当两者均存在且未耗尽时返回倒计时文本；否则返回 null。
 *
 * 返回值：
 * - null：不显示（无超时信息 / 已归零）
 * - { label, urgent }：剩余描述与是否即将超时（剩余 ≤10s 标记为紧急）
 */

import {useEffect, useState} from 'react'

export interface CountdownResult {
    /** 剩余时间描述（如 "(10s)" / "已超时"） */
    label: string
    /** 是否紧急（剩余 ≤10s 或已超时），用于红色高亮 */
    urgent: boolean
}

export function useToolCountdown(timeoutMs?: number, startedAt?: number): CountdownResult | null {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (timeoutMs === undefined || startedAt === undefined) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [timeoutMs, startedAt])

    // 缺任一条件 → 不显示
    if (timeoutMs === undefined || startedAt === undefined || timeoutMs <= 0) return null

    const remainingMs = timeoutMs - (now - startedAt)
    if (remainingMs <= 0) {
        return {label: '已超时', urgent: true}
    }

    const totalSec = Math.ceil(remainingMs / 1000)
    // 括号紧凑格式：紧跟工具名显示为 bash (10s)；超 1 分钟显示 (2m5s)、超 1 小时显示 (1h5m)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    let inner: string
    if (h > 0) inner = `${h}h${m}m`
    else if (m > 0) inner = `${m}m${s}s`
    else inner = `${s}s`

    return {
        label: `(${inner})`,
        urgent: totalSec <= 10,
    }
}
