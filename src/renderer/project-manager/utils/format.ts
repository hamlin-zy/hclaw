// 相对时间格式化：`<1min → 'just now'`, `<1h → 'Xm ago'`, `<24h → 'Xh ago'`,
// `<7d → 'Xd ago'`, 否则 ISO 日期简化为 `YYYY-MM-DD`。
// 输入兼容毫秒时间戳（number）或 ISO 字符串；两者都会先归一到毫秒。

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const pad = (n: number) => (n < 10 ? '0' + n : '' + n)

export function relativeTime(input: number | string): string {
  const ts = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(ts)) return ''
  const delta = Date.now() - ts
  if (delta < MIN) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
