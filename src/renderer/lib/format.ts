/**
 * 渲染进程共享格式化工具函数
 */

import {MIN_DECODE_MS} from '@shared/types'
import {DEFAULT_USD_CNY_RATE} from '@shared/exchangeRate'

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

/** 紧凑格式化 token 数：≥1e9 → x.xB；≥1e6 → x.xM；≥1000 → x.xk；否则原样 */
export function formatTokenCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
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
  // 防爆表：时长过短视为首 token 边界虚短的异常数据（历史坏数据/网关抖动），
  // 按 MIN_DECODE_MS 保守下限计算，避免 190000 t/s 级异常值。
  const effective = Math.max(MIN_DECODE_MS, durationMs)
  return outputTokens / (effective / 1000)
}

/** 货币类型 */
export type Currency = 'USD' | 'CNY'

// 兜底默认汇率（7.2）统一定义在 @shared/exchangeRate，主进程 / 渲染进程共用一份
let currentUsdCnyRate = DEFAULT_USD_CNY_RATE

/** 更新运行时汇率（主进程启动同步实时汇率后写入）；非法值忽略，保留当前值 */
export function setUsdCnyRate(rate: unknown): void {
  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
    currentUsdCnyRate = rate
  }
}

/** 当前 USD→CNY 汇率：已同步用实时值，否则回退固定默认值 */
export function getUsdCnyRate(): number {
  return currentUsdCnyRate
}

/** 成本格式化：0 或负数 → '—'（未定价）；<0.01 → '<$0.01'；否则 $x.xx（四舍五入到分）。CNY 按实时汇率换算（未同步回退默认值）。 */
export function formatCost(usd: number, currency: Currency = 'USD'): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return '—'
  if (currency === 'CNY') {
    const cny = usd * getUsdCnyRate()
    // 加 1e-9 epsilon 规避 IEEE-754 浮点边界（如 10.715 存为 10.714999…，toFixed(2) 会得 10.71 而非 10.72）
    return `¥${(cny + 1e-9).toFixed(2)}`
  }
  if (usd < 0.01) return '<$0.01'
  return `$${(usd + 1e-9).toFixed(2)}`
}

/** 占比格式化：0-100 整数百分比；负数/NaN → '0' */
export function formatPercent(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0'
  return String(Math.round(n * 100))
}
