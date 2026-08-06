/**
 * 日期工具函数
 *
 * ⚠️ 必须用本地时区字段拼 yyyy-MM-dd，禁用 new Date().toISOString()：
 * toISOString() 返回 UTC 时间，在中国时区（UTC+8）晚 20 点后会跨天，
 * 导致日期显示为昨天。
 */

/** 个位数补零 */
function pad(n: number): string {
    return n.toString().padStart(2, '0')
}

/** 本地时区 yyyy-MM-dd（如 2026-08-06），默认当前时间 */
export function formatYmd(date: Date = new Date()): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 系统提示词缓存是否过期：无构建日期，或构建日期不是今天 → true（需重建） */
export function isCacheStale(buildDate: string | undefined, today: string): boolean {
    return !buildDate || buildDate !== today
}
