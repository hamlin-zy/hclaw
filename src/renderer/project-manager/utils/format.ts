// 相对时间格式化：`<1min → '刚刚'`, `<1h → 'X 分钟前'`, `<24h → 'X 小时前'`,
// `<7d → 'X 天前'`, 否则 ISO 日期简化为 `YYYY-MM-DD`。
// 输入兼容毫秒时间戳（number）或 ISO 字符串；两者都会先归一到毫秒。

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const pad = (n: number) => (n < 10 ? '0' + n : '' + n)

export function relativeTime(input: number | string): string {
  const ts = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(ts)) return ''
  const delta = Date.now() - ts
  if (delta < MIN) return '刚刚'
  if (delta < HOUR) return `${Math.floor(delta / MIN)} 分钟前`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
