/**
 * 渲染进程共享格式化工具函数
 */

/** 相对时间格式化 */
export function getRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 将时长毫秒格式化为分级文本：<1min→n秒；<1h→m分n秒；>=1h→x小时m分n秒 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}小时${m}分${s}秒`
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

/** 提取路径最后一段（浏览器环境中替代 path.basename） */
export function getBasename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || p
}

/** 生成带时间戳和随机因子的文件附件 ID */
export function generateFileId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/** 截断字符串 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

/** 将名称转换为 URL 友好的 slug */
export function toSlug(name: string): string {
  return (name || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item'
}

/** 格式化 token 数为可读形式（≥1000 显示为 x.xk） */
export function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

/** 解码吞吐展示：≥10 取整，<10 保留一位小数，负数 clamp 到 0。 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** 速率：outputTokens ÷ (durationMs/1000)；非法输入返回 null。 */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (typeof outputTokens !== 'number' || outputTokens <= 0) return null
  if (typeof durationMs !== 'number' || durationMs <= 0) return null
  return outputTokens / (durationMs / 1000)
}
