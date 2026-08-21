import {memo, useRef, useState, useCallback, useEffect} from 'react'
import {createPortal} from 'react-dom'
import {AppWindow, Database, Gauge} from 'lucide-react'
import {formatTokenCount, formatTokensPerSecond, tokensPerSecond} from '../lib/format'
import {useMessageTokenStats} from '../hooks/useMessageTokenStats'
import {useWindowUsage} from '../hooks/useWindowUsage'
import MetricBadge from './MetricBadge'

/** 公式 hover 提示 — 问号图标，hover 显示计算公式 */
function FormulaTip({text}: {text: string}) {
  return (
    <span className="relative inline-flex group">
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-current text-[9px] text-[var(--text-muted)] cursor-help leading-none">?</span>
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-[var(--surface-overlay)] text-[10px] text-[var(--text-primary)] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-lg border border-[var(--border)]">
        {text.split('\n').map((line, i) => (
          <span key={i} style={{display: 'block'}}>{line}</span>
        ))}
      </span>
    </span>
  )
}

/** 指标行前的彩色圆点（带光晕） */
function Dot({color, glow}: {color: string; glow: string}) {
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full mr-1"
      style={{backgroundColor: color, boxShadow: `0 0 0 3px ${glow}`}}/>
  )
}

/**
 * 缓存命中率徽章颜色：≥90 优秀绿 / 70~90 一般黄 / <70 警惕红。
 * 注意：与 MetricBadge 内置分级的阈值方向相反（命中率越高越健康，
 * 内置分级是百分比越高越危险），因此不能复用内置分级，必须显式传入 accent。
 */
function cacheRateAccent(rate: number): string {
  return rate >= 90 ? 'var(--success)' : rate >= 70 ? 'var(--warning)' : 'var(--error)'
}

/** 平均吞吐徽章颜色：>150 高速绿 / 100~150 正常蓝 / 50~100 慢黄 / <=50 太慢红 */
function throughputAccent(tps: number): string {
  return tps > 150 ? 'var(--success)' : tps > 100 ? 'var(--info)' : tps > 50 ? 'var(--warning)' : 'var(--error)'
}

/** 命中率（%）= 缓存命中 ÷（输入 + 缓存命中），分母至少为 1 避免除零 */
function hitRateOf(cacheRead: number, inputTokens: number): number {
  return Math.round((cacheRead / Math.max(inputTokens + cacheRead, 1)) * 100)
}

/**
 * 缓存命中率显示组件
 * 显示缓存命中百分比，悬停时展示详细统计
 * 累计值 = 本次会话所有请求的汇总
 * 当前值 = 最后一次请求的明细
 *
 * tooltip 通过 Portal 渲染到 document.body，突破祖先容器的 overflow: hidden 裁剪
 */
const CacheRateTooltip = memo(function CacheRateTooltip() {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const [show, setShow] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState({bottom: 0, right: 0})

  const stats = useMessageTokenStats()
  const {pct} = useWindowUsage(stats)

  const totalInput = stats.totalInputTokens
  const totalCacheRead = stats.totalCacheReadTokens
  const currentInput = stats.currentInputTokens
  const currentCacheRead = stats.currentCacheReadTokens
  const currentTotalTokens = currentInput + currentCacheRead

  // tooltip 明细保留累计口径（与「累计/当前」两列对比一致）
  const rate = hitRateOf(totalCacheRead, totalInput)
  // tooltip 平均吞吐 = Σ输出token ÷ Σ解码时长（全程累计，非末次）
  const avgDecodeRate = tokensPerSecond(stats.totalOutputTokens, stats.totalDecodeMs)
  // tooltip 平均首字 = Σ首字延迟 ÷ 有效样本数（ttftMs 已排除重试干扰，attempt 级采集）
  const avgTtftSeconds = stats.ttftCount > 0 ? stats.totalTtftMs / stats.ttftCount / 1000 : null

  // 徽章口径 = 末次请求（InputArea 下方统计只针对最后一次 LLM 请求）
  const lastRate = hitRateOf(currentCacheRead, currentInput)
  // 末次吞吐 = 最后一条携带文本解码时序（ttftMs）的请求：
  // 纯工具调用轮次无文本输出（ttftMs/decodeMs 缺失），回退到上一个有文本解码的轮次，
  // 避免 t/s 徽章在工具轮次后消失
  const lastDecodeRate = stats.lastTimedStats
    ? tokensPerSecond(stats.lastTimedStats.outputTokens, stats.lastTimedStats.decodeMs)
    : null

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 8,
      right: window.innerWidth - rect.right,
    })
  }, [])

  const scheduleShow = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    updatePosition()
    setShow(true)
  }, [updatePosition])

  const scheduleHide = useCallback(() => {
    hideTimerRef.current = setTimeout(() => setShow(false), 100)
  }, [])

  const handleTooltipEnter = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [])

  // 窗口 resize 时更新 tooltip 位置
  useEffect(() => {
    if (!show) return
    const onResize = () => updatePosition()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [show, updatePosition])

  if (stats.requestCount === 0) return null

  const tooltipContent = (
    <div
      onMouseEnter={handleTooltipEnter}
      onMouseLeave={scheduleHide}
      className="fixed z-[9999] bg-[var(--surface-elevated)] border border-[var(--border)]
                 rounded-lg shadow-overlay p-3 min-w-[260px]"
      style={{bottom: pos.bottom, right: pos.right}}
    >
      <div className="text-[11px] leading-relaxed text-[var(--text-primary)]">
        {/* 分区 1：核心指标 5 行 */}
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-8">
            <span className="flex items-center gap-1">
              缓存命中率
              <FormulaTip text={`平均命中率 = ${formatTokenCount(totalCacheRead)} / (${formatTokenCount(totalInput)} + ${formatTokenCount(totalCacheRead)}) = ${rate}%\n末次命中率 = ${formatTokenCount(currentCacheRead)} / (${formatTokenCount(currentInput)} + ${formatTokenCount(currentCacheRead)}) = ${lastRate}%`}/>
            </span>
            <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
              <Dot color="var(--success)" glow="var(--success-muted)"/>
              {rate}%
            </span>
          </div>
          <div className="flex items-center justify-between gap-8">
            <span>窗口使用率</span>
            <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
              <Dot color="var(--info)" glow="var(--info-muted)"/>
              {pct}%
            </span>
          </div>
          <div className="flex items-center justify-between gap-8">
            <span className="flex items-center gap-1">
              窗口占用
              <FormulaTip text={`窗口占用 = 输入 ${formatTokenCount(currentInput)} + 缓存命中 ${formatTokenCount(currentCacheRead)} = ${formatTokenCount(currentTotalTokens)}`}/>
            </span>
            <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>{formatTokenCount(currentTotalTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-8">
            <span>平均首字</span>
            <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
              <Dot color="var(--warning)" glow="var(--warning-muted)"/>
              {avgTtftSeconds != null ? `${avgTtftSeconds.toFixed(1)}s` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-8">
            <span>平均吞吐</span>
            <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
              <Dot color="var(--brand-primary)" glow="var(--brand-muted)"/>
              {avgDecodeRate != null ? `${formatTokensPerSecond(avgDecodeRate)} t/s` : '—'}
            </span>
          </div>
        </div>

        {/* 分区 2：Token 统计表 */}
        <div className="border-t border-dashed border-[var(--border-emphasis)] mt-1.5 pt-1.5">
          <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-0.5 text-[10px] text-[var(--text-muted)]">
            <span/><span className="text-right">累计</span><span className="text-right">当前</span>
          </div>
          <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-0.5 text-[11px]">
            <span className="text-[var(--text-muted)]">输入</span>
            <span className="text-right tabular-nums">{formatTokenCount(totalInput)}</span>
            <span className="text-right tabular-nums" style={{color: 'var(--info)'}}>{formatTokenCount(currentInput)}</span>
            <span className="text-[var(--text-muted)]">缓存命中</span>
            <span className="text-right tabular-nums">{formatTokenCount(totalCacheRead)}</span>
            <span className="text-right tabular-nums" style={{color: 'var(--brand-primary)'}}>{formatTokenCount(currentCacheRead)}</span>
            <span className="text-[var(--text-muted)]">输出</span>
            <span className="text-right tabular-nums">{formatTokenCount(stats.totalOutputTokens)}</span>
            <span className="text-right tabular-nums" style={{color: 'var(--info)'}}>{formatTokenCount(stats.currentOutputTokens)}</span>
          </div>
        </div>

        {/* 分区 3：次级指标 */}
        <div className="border-t border-dashed border-[var(--border-emphasis)] mt-1.5 pt-1.5">
          <div className="grid grid-cols-[1fr_1fr] gap-x-6 gap-y-0.5 text-[11px]">
            <div className="flex justify-between"><span>LLM 请求</span><b className="tabular-nums">{stats.requestCount} 次</b></div>
            <div className="flex justify-between"><span>工具调用</span><b className="tabular-nums">{stats.toolCallCount} 次</b></div>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <>
      <span
        data-name="input-toolbar-cache-rate"
        ref={triggerRef}
        className="flex items-center gap-1 text-sm text-[var(--text-muted)] cursor-help tabular-nums leading-none whitespace-nowrap"
        onMouseEnter={scheduleShow}
        onMouseLeave={scheduleHide}
      >
        {/* 缓存命中率徽章（进度环 = 末次请求命中率，图标 = 数据库） */}
        <MetricBadge pct={lastRate} accent={cacheRateAccent(lastRate)} icon={<Database className="w-3 h-3"/>}>
          缓存 {lastRate}%
        </MetricBadge>
        {/* 窗口占用徽章（进度环 = 窗口使用率，图标 = 窗口方块，内置分级） */}
        <MetricBadge pct={pct} icon={<AppWindow className="w-3 h-3"/>}>窗口 {formatTokenCount(currentTotalTokens)}</MetricBadge>
        {/* 末次吞吐徽章（静态边框，图标 = 速度计，无时序数据时隐藏） */}
        {lastDecodeRate != null && (
          <MetricBadge accent={throughputAccent(lastDecodeRate)} icon={<Gauge className="w-3 h-3"/>}>
            {formatTokensPerSecond(lastDecodeRate)} t/s
          </MetricBadge>
        )}
      </span>
      {show && createPortal(tooltipContent, document.body)}
    </>
  )
})

export default CacheRateTooltip
