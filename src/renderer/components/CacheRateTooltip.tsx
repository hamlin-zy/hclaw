import {memo, useRef, useState, useCallback, useEffect, useMemo} from 'react'
import {createPortal} from 'react-dom'
import {AppWindow, Database, Gauge} from 'lucide-react'
import {formatTokenCount, formatTokensPerSecond, tokensPerSecond} from '../lib/format'
import {useMessageTokenStats} from '../hooks/useMessageTokenStats'
import {useModelContextLength, useWindowUsage} from '../hooks/useWindowUsage'
import {useAgentStore} from '../stores/agentStore'
import {useLLMStore} from '../stores/llmStore'
import {usePrimaryRole} from '../hooks/usePrimaryRole'
import {resolveActiveModel} from '../lib/modelResolution'
import {computeUsagePct, type MessageTokenStats} from '@shared/messageTokenStats'
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

/** 模型条目展示文案：「{服务商名}: {模型名}」（模型名缺失时仅显示服务商名） */
function formatModelLabel(providerName: string, model: string): string {
  return model ? `${providerName}: ${model}` : providerName
}

/** 生效模型无历史数据时传给 useWindowUsage 的零值统计（徽章显示占位，保留卡片入口） */
const ZERO_STATS: MessageTokenStats = {
  requestCount: 0,
  toolCallCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalDecodeMs: 0,
  totalTtftMs: 0,
  ttftCount: 0,
  currentInputTokens: 0,
  currentOutputTokens: 0,
  currentCacheReadTokens: 0,
  currentDecodeMs: 0,
  currentHasTtft: false,
  lastTimedStats: null,
}

/**
 * 缓存命中率显示组件
 * 显示缓存命中百分比，悬停时展示详细统计
 *
 * 徽章口径（用户明确要求）=「当前使用的模型（会话生效模型）」最后一次请求的数据，
 * 不跟随卡片切换视图；生效模型无数据时徽章显示占位（'—'）但保留 hover 卡片入口。
 * 卡片顶部提供模型切换器：默认选中生效模型，可切换查看本会话历史使用过的各模型统计。
 * （累计/当前口径与切换视图一致：累计 = 所选模型所有请求汇总，当前 = 所选模型最后一次请求）
 *
 * tooltip 通过 Portal 渲染到 document.body，突破祖先容器的 overflow: hidden 裁剪
 */
const CacheRateTooltip = memo(function CacheRateTooltip() {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const switcherRef = useRef<HTMLDivElement>(null)
  const [show, setShow] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState({bottom: 0, right: 0})
  // 卡片模型切换器：selectedKey = 用户显式选中的模型分组键（null = 跟随生效模型）
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  const {stats, byModel} = useMessageTokenStats()

  // 会话生效模型（与 ModelSelector 同源解析：modelOverride → 无则 primary 兜底）
  const modelOverride = useAgentStore(s => s.modelOverride)
  const providers = useLLMStore(s => s.providers)
  // 当前方案 primary 角色（无 override 时兜底；与 ModelSelector 共用 usePrimaryRole，防口径漂移）
  const primaryRole = usePrimaryRole()
  const activeModel = useMemo(
    () => resolveActiveModel({override: modelOverride, providers, primaryRole}),
    [modelOverride, providers, primaryRole],
  )

  // 生效模型在历史数据中的分组（历史数据 providerName 缺失时按 provider 类型名分组 → 双匹配）
  const activeGroup = useMemo(() => {
    if (!activeModel.modelName) return undefined
    return byModel.find(g =>
      g.model === activeModel.modelName &&
      (g.providerName === activeModel.providerName || g.providerName === activeModel.providerType),
    )
  }, [byModel, activeModel])

  // 卡片当前查看的模型组：显式选择优先；未选择时默认生效模型（可能无数据 → 空态）
  const selectedGroup = useMemo(() => {
    if (selectedKey != null) return byModel.find(g => g.key === selectedKey) ?? activeGroup
    return activeGroup
  }, [selectedKey, byModel, activeGroup])

  // 徽章口径 = 生效模型组（不跟随卡片切换视图）；无数据 → 占位但保留卡片入口
  const badgeStats = activeGroup?.stats ?? null
  // 徽章环分母 = 生效模型名（与分子同口径；防止空闲时 agentState.currentModelName 清空回退 primary 与生效模型不一致）
  const {pct} = useWindowUsage(badgeStats ?? ZERO_STATS, activeModel.modelName)

  // 卡片所选模型的窗口大小（按模型名查询，与徽章环共用 useModelContextLength；随切换重查）
  const selectedContextLength = useModelContextLength(selectedGroup?.model ?? '')

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
    setSwitcherOpen(false)
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

  // 点击切换器外部关闭下拉
  useEffect(() => {
    if (!switcherOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (switcherRef.current?.contains(target)) return
      setSwitcherOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [switcherOpen])

  const handleSelectModel = useCallback((key: string) => {
    setSelectedKey(key)
    setSwitcherOpen(false)
  }, [])

  // 卡片关闭 → 重置模型选择（下次打开默认回到生效模型）
  useEffect(() => {
    if (!show) setSelectedKey(null)
  }, [show])

  // 下拉按模型名去重：同模型 providerName 有/缺失会按分组键拆成两组 → 保留末次使用的那组
  // （byModel 已按 lastUsedAt 倒序，取首个即可；无模型名的条目不参与去重）
  const switcherModels = useMemo(() => {
    const seen = new Set<string>()
    return byModel.filter(item => {
      if (!item.model) return true
      if (seen.has(item.model)) return false
      seen.add(item.model)
      return true
    })
  }, [byModel])

  // 整个会话无任何请求数据 → 组件不渲染（保持现状）
  if (stats.requestCount === 0) return null

  // ── 徽章口径：生效模型组末次请求 ─────────────────────────────
  const badgeRate = badgeStats
    ? hitRateOf(badgeStats.currentCacheReadTokens, badgeStats.currentInputTokens)
    : null
  const badgeWindowTokens = badgeStats
    ? badgeStats.currentInputTokens + badgeStats.currentCacheReadTokens
    : null
  // 末次吞吐 = 最后一条携带文本解码时序（ttftMs）的请求：
  // 纯工具调用轮次无文本输出（ttftMs/decodeMs 缺失），回退到上一个有文本解码的轮次，
  // 避免 t/s 徽章在工具轮次后消失
  const badgeTps = badgeStats?.lastTimedStats
    ? tokensPerSecond(badgeStats.lastTimedStats.outputTokens, badgeStats.lastTimedStats.decodeMs)
    : null

  // ── 卡片口径：所选模型（默认生效模型）─────────────────────────
  const selectedStats = selectedGroup?.stats ?? null
  const selRate = selectedStats ? hitRateOf(selectedStats.totalCacheReadTokens, selectedStats.totalInputTokens) : null
  // tooltip 明细保留累计口径（与「累计/当前」两列对比一致）
  const selLastRate = selectedStats ? hitRateOf(selectedStats.currentCacheReadTokens, selectedStats.currentInputTokens) : null
  // tooltip 平均吞吐 = Σ输出token ÷ Σ解码时长（全程累计，非末次）
  const selAvgDecodeRate = selectedStats ? tokensPerSecond(selectedStats.totalOutputTokens, selectedStats.totalDecodeMs) : null
  // tooltip 平均首字 = Σ首字延迟 ÷ 有效样本数（ttftMs 已排除重试干扰，attempt 级采集）
  const selAvgTtftSeconds = selectedStats && selectedStats.ttftCount > 0
    ? selectedStats.totalTtftMs / selectedStats.ttftCount / 1000
    : null
  const selWindowTokens = selectedStats
    ? selectedStats.currentInputTokens + selectedStats.currentCacheReadTokens
    : null
  const selWindowPct = selectedStats
    ? computeUsagePct(selectedStats.currentInputTokens + selectedStats.currentCacheReadTokens, selectedContextLength)
    : null
  const switcherLabel = selectedGroup
    ? formatModelLabel(selectedGroup.providerName, selectedGroup.model)
    : activeModel.label

  const tooltipContent = (
    <div
      onMouseEnter={handleTooltipEnter}
      onMouseLeave={scheduleHide}
      className="fixed z-[9999] bg-[var(--surface-elevated)] border border-[var(--border)]
                 rounded-lg shadow-overlay p-3 min-w-[260px]"
      style={{bottom: pos.bottom, right: pos.right}}
    >
      <div className="text-[11px] leading-relaxed text-[var(--text-primary)]">
        {/* 卡片顶部模型切换器：默认选中生效模型；下拉 = 会话历史使用过的模型（末次使用倒序） */}
        <div ref={switcherRef} className="relative mb-1.5">
          <button
            type="button"
           data-name="cache-rate-model-switcher"
            onClick={() => setSwitcherOpen(o => !o)}
            className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] text-[11px] text-[var(--text-primary)] hover:border-[var(--border-emphasis)] transition-colors focus:outline-none"
            title="切换模型查看统计"
          >
            <span className="truncate min-w-0">{switcherLabel}</span>
            <svg className={`w-2.5 h-2.5 shrink-0 text-[var(--text-muted)] transition-transform ${switcherOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {switcherOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 z-20 max-h-[180px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] shadow-overlay">
              {switcherModels.map(item => {
                const isActive = item.key === (selectedGroup?.key ?? selectedKey)
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleSelectModel(item.key)}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] transition-colors ${
                      isActive
                        ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
                    }`}
                   data-name="cache-rate-tooltip-button">
                    <span className="truncate min-w-0">{formatModelLabel(item.providerName, item.model)}</span>
                    {isActive && (
                      <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {selectedStats ? (
          <>
            {/* 分区 1：核心指标 5 行 */}
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-8">
                <span className="flex items-center gap-1">
                  缓存命中率
                  <FormulaTip text={`平均命中率 = ${formatTokenCount(selectedStats.totalCacheReadTokens)} / (${formatTokenCount(selectedStats.totalInputTokens)} + ${formatTokenCount(selectedStats.totalCacheReadTokens)}) = ${selRate}%\n末次命中率 = ${formatTokenCount(selectedStats.currentCacheReadTokens)} / (${formatTokenCount(selectedStats.currentInputTokens)} + ${formatTokenCount(selectedStats.currentCacheReadTokens)}) = ${selLastRate}%`}/>
                </span>
                <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
                  <Dot color="var(--success)" glow="var(--success-muted)"/>
                  {selRate}%
                </span>
              </div>
              <div className="flex items-center justify-between gap-8">
                <span>窗口使用率</span>
                <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
                  <Dot color="var(--info)" glow="var(--info-muted)"/>
                  {selWindowPct}%
                </span>
              </div>
              <div className="flex items-center justify-between gap-8">
                <span className="flex items-center gap-1">
                  窗口占用
                  <FormulaTip text={`窗口占用 = 输入 ${formatTokenCount(selectedStats.currentInputTokens)} + 缓存命中 ${formatTokenCount(selectedStats.currentCacheReadTokens)} = ${formatTokenCount(selWindowTokens ?? 0)}`}/>
                </span>
                <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>{formatTokenCount(selWindowTokens ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between gap-8">
                <span>平均首字</span>
                <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
                  <Dot color="var(--warning)" glow="var(--warning-muted)"/>
                  {selAvgTtftSeconds != null ? `${selAvgTtftSeconds.toFixed(1)}s` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-8">
                <span>平均吞吐</span>
                <span className="tabular-nums" style={{color: 'var(--brand-primary)'}}>
                  <Dot color="var(--brand-primary)" glow="var(--brand-muted)"/>
                  {selAvgDecodeRate != null ? `${formatTokensPerSecond(selAvgDecodeRate)} t/s` : '—'}
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
                <span className="text-right tabular-nums">{formatTokenCount(selectedStats.totalInputTokens)}</span>
                <span className="text-right tabular-nums" style={{color: 'var(--info)'}}>{formatTokenCount(selectedStats.currentInputTokens)}</span>
                <span className="text-[var(--text-muted)]">缓存命中</span>
                <span className="text-right tabular-nums">{formatTokenCount(selectedStats.totalCacheReadTokens)}</span>
                <span className="text-right tabular-nums" style={{color: 'var(--brand-primary)'}}>{formatTokenCount(selectedStats.currentCacheReadTokens)}</span>
                <span className="text-[var(--text-muted)]">输出</span>
                <span className="text-right tabular-nums">{formatTokenCount(selectedStats.totalOutputTokens)}</span>
                <span className="text-right tabular-nums" style={{color: 'var(--info)'}}>{formatTokenCount(selectedStats.currentOutputTokens)}</span>
              </div>
            </div>

            {/* 分区 3：次级指标 */}
            <div className="border-t border-dashed border-[var(--border-emphasis)] mt-1.5 pt-1.5">
              <div className="grid grid-cols-[1fr_1fr] gap-x-6 gap-y-0.5 text-[11px]">
                <div className="flex justify-between"><span>LLM 请求</span><b className="tabular-nums">{selectedStats.requestCount} 次</b></div>
                <div className="flex justify-between"><span>工具调用</span><b className="tabular-nums">{selectedStats.toolCallCount} 次</b></div>
              </div>
            </div>
          </>
        ) : (
          /* 生效模型无历史数据（会话有其他模型数据）→ 空态提示，历史模型仍可切换 */
          <div className="py-3 text-center text-[11px] text-[var(--text-muted)]">该模型暂无请求数据</div>
        )}
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
        {/* 缓存命中率徽章（进度环 = 生效模型末次请求命中率，图标 = 数据库；无数据 → 占位） */}
        <MetricBadge pct={badgeRate ?? undefined} accent={badgeRate != null ? cacheRateAccent(badgeRate) : 'var(--border)'} icon={<Database className="w-3 h-3"/>}>
          缓存 {badgeRate != null ? `${badgeRate}%` : '—'}
        </MetricBadge>
        {/* 窗口占用徽章（进度环 = 生效模型窗口使用率，图标 = 窗口方块，内置分级；无数据 → 占位） */}
        <MetricBadge pct={pct} icon={<AppWindow className="w-3 h-3"/>}>
          窗口 {badgeWindowTokens != null ? formatTokenCount(badgeWindowTokens) : '—'}
        </MetricBadge>
        {/* 末次吞吐徽章（静态边框，图标 = 速度计，无时序数据时隐藏） */}
        {badgeTps != null && (
          <MetricBadge accent={throughputAccent(badgeTps)} icon={<Gauge className="w-3 h-3"/>}>
            {formatTokensPerSecond(badgeTps)} t/s
          </MetricBadge>
        )}
      </span>
      {show && createPortal(tooltipContent, document.body)}
    </>
  )
})

export default CacheRateTooltip
