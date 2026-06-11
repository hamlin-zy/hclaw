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
