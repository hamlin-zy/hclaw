import {memo} from 'react'
import {formatTokenCount} from '../lib/format'

/**
 * 上下文窗口使用率徽章
 *
 * - 常驻显示"窗口 12.3k"
 * - 徽章边框用 conic-gradient + mask 实现精确进度（pct% 填充高亮色）
 * - 颜色分级：<50% 健康绿、50-80% 提醒黄、>=80% 危险红（复用主题 token，自动适配四主题）
 * - 纯展示组件，不弹 tooltip（tooltip 由外层 CacheRateTooltip 统一提供）
 */
const ContextUsageBadge = memo(function ContextUsageBadge({
  numerator,
  pct,
}: {
  numerator: number
  pct: number
}) {
  const accent = pct >= 80 ? 'var(--error)' : pct >= 50 ? 'var(--warning)' : 'var(--success)'

  return (
    <span className="relative inline-flex items-center align-middle">
      {/* 进度边框层：conic-gradient 按 pct 填充，mask 只留边框环 */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          padding: '1.5px',
          background: `conic-gradient(${accent} ${pct}%, var(--border) 0)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          maskComposite: 'exclude',
        }}
      />
      {/* 文字层 */}
      <span className="relative px-2 py-0.5 text-sm tabular-nums leading-none">
        窗口 {formatTokenCount(numerator)}
      </span>
    </span>
  )
})

export default ContextUsageBadge
