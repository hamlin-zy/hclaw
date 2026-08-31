/**
 * 相对时间格式化（与会话列表 ConversationsDialog 同源格式）：
 * 刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD
 */
export function formatRelativeTime(ts: number): string {
    const now = Date.now()
    const diff = now - ts
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`
    return new Date(ts).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    })
}
