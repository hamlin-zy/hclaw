/**
 * 模型详情弹窗（Task 7）
 *
 * 视觉基准：tmp/model-detail-config-demo.html（结构/样式/交互照搬）。
 * - 静态配置：模型类型多选 chips + 4 维价格（录入即真，commitRow 折算）
 * - 运行时参数：留空 = 不落库，placeholder 显示兜底值（来源经 resolveModelParams）
 * - 「确定」：validateModelDetailDraft 门禁 → commitRow 折算价格 → commitModelDetail
 *   组装 → onConfirm(next)（父级不落库，随外层「保存」一并持久化）
 * - 「取消」/遮罩/关闭按钮 直接 onClose 丢弃全部编辑
 */
import {useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {ModelType, ProviderModel} from '@shared/types'
import type {Currency} from '@shared/pricing'
import {tokenToPerM} from '@shared/pricing'
// 共享候选类型（唯一真源）：env.d.ts 内的 modelMetaEndpoints 返回形状为 ambient 内联副本，
// 与 shared/openRouterProviders.ts 的 OpenRouterProviderOption 保持同步（ambient 文件无法 import）
import type {OpenRouterProviderOption} from '@shared/openRouterProviders'
import {commitRow, displayEnteredCell, reverseHintPrice, formatPrice, type PriceEdits, type PriceField} from '../../../lib/priceEditing'
import {commitModelDetail, validateModelDetailDraft, type ModelDetailDraft} from '../../../lib/modelDetailCommit'
import {resolveModelParams, DEFAULT_MAX_CONTEXT_TOKENS} from '@shared/modelParams'
import {RemoveIcon, RefreshIcon} from '../../icons'
import {INPUT_FOCUS} from '../../../lib/inputFocus'

const PRICE_FIELDS: Array<{key: PriceField; label: string}> = [
  {key: 'input', label: '输入价'},
  {key: 'output', label: '输出价'},
  {key: 'cacheRead', label: '缓存读'},
  {key: 'cacheWrite', label: '缓存写'},
]

const MODEL_TYPES: Array<{value: ModelType; label: string}> = [
  {value: 'text', label: '文本'},
  {value: 'image', label: '图像'},
  {value: 'voice', label: '语音'},
  {value: 'video', label: '视频'},
  {value: 'music', label: '音乐'},
  {value: 'multimodal', label: '多模态'},
  {value: 'embedding', label: '向量'},
]

/** OpenRouter input_modalities 字符串 → ModelType（未识别模态忽略） */
function modalityToType(m: string): ModelType | null {
  if (m === 'text') return 'text'
  if (m === 'image') return 'image'
  if (m === 'audio') return 'voice'
  if (m === 'video') return 'video'
  return null
}

interface OpenRouterMeta {
  contextLength: number
  inputModalities: string[] | null
  inputPrice?: number
  outputPrice?: number
  cacheReadPrice?: number
  cacheWritePrice?: number
}

/**
 * 圆形「?」信息提示：hover 时以 fixed 定位浮层显示，按图标实时位置 + 视口宽高 clamp，
 * 不受弹窗 overflow / 圆角裁剪影响（右侧列 tooltip 也不会溢出卡片右边界）。
 */
function InfoTip({children}: {children: React.ReactNode}) {
  const [pos, setPos] = useState<{x: number; y: number} | null>(null)
  return (
    <span
      className="inline-flex h-[13px] w-[13px] shrink-0 cursor-help items-center justify-center rounded-full bg-gray-200 text-[9px] font-semibold text-gray-500 hover:bg-brand-500 hover:text-white"
      onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setPos({x: r.left + r.width / 2, y: r.bottom}) }}
      onMouseLeave={() => setPos(null)}>
      ?
      {pos && (() => {
        const W = 230, H = 80, pad = 8
        const left = Math.max(pad, Math.min(pos.x - W / 2, window.innerWidth - W - pad))
        const top = Math.min(pos.y + 6, window.innerHeight - H - pad)
        return (
          <span
            className="fixed z-[100001] block w-[230px] rounded-lg bg-gray-800 px-2.5 py-2 text-left text-[11px] font-normal leading-relaxed tracking-normal text-[var(--text-secondary)] pointer-events-none"
            style={{left, top}}>
            {children}
          </span>
        )
      })()}
    </span>
  )
}

interface ModelDetailModalProps {
  open: boolean
  providerName: string
  model: ProviderModel | null            // 内存引用（编辑态由组件内部管理）
  /** 系统设置默认值（经 props 传入，不在组件内订 store） */
  settingsDefaults: {defaultTemperature?: number; defaultMaxTokens?: number}
  /** 汇率（CNY/USD），父级已有的就绪值 */
  rate: number
  /** Base URL 识别为 OpenRouter 时才展示「固定服务商」字段（父级派生，本组件不自判） */
  isOpenRouter?: boolean
  onClose: () => void
  onConfirm: (next: ProviderModel) => void   // 仅在值变化时回调；父级不落库
}

export function ModelDetailModal({open, providerName, model, settingsDefaults, rate, isOpenRouter, onClose, onConfirm}: ModelDetailModalProps) {
  // ── 弹窗内部编辑态（open 时从 model 初始化，关闭即丢弃）──
  const [draft, setDraft] = useState<ModelDetailDraft>({maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: [], openRouterProvider: undefined})
  const [priceEdits, setPriceEdits] = useState<PriceEdits[string]>({})
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [localModel, setLocalModel] = useState<ProviderModel | null>(null)
  const [orMeta, setOrMeta] = useState<OpenRouterMeta | null>(null)
  // chips 是否仍为 OpenRouter 声明来源（青色虚线）；用户手动点选任意项后转自定义
  const [typesFromOr, setTypesFromOr] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── OpenRouter 固定服务商候选（网关 /endpoints；详情弹窗打开时拉一次）──
  const [endpoints, setEndpoints] = useState<OpenRouterProviderOption[]>([])
  const [endpointsLoading, setEndpointsLoading] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelPos, setPanelPos] = useState<{left: number; width: number; top: number; dropUp: boolean} | null>(null)
  const endpointInputRef = useRef<HTMLInputElement>(null)
  const endpointPanelRef = useRef<HTMLDivElement>(null)
  const endpointRefreshRef = useRef<HTMLButtonElement>(null)
  const endpointSeqRef = useRef(0)

  /**
   * 拉取服务商候选（force = 刷新按钮强制重拉）。
   * - seqRef 防竞态：刷新/切换模型后旧响应晚到直接丢弃
   * - 仅成功且非空时替换候选：失败/空响应保留旧候选（registry 失败不破坏缓存，面板不闪空），
   *   方法未落地 → 无候选 = 静默降级为纯文本输入（不提示错误）
   */
  const loadEndpoints = (force?: boolean) => {
    const api = window.electronAPI
    const modelName = model?.name
    if (!api?.modelMetaEndpoints || !isOpenRouter || !modelName) return
    const seq = ++endpointSeqRef.current
    setEndpointsLoading(true)
    api.modelMetaEndpoints(modelName, force).then(r => {
      if (endpointSeqRef.current !== seq) return
      const list = r?.providers
      if (list && list.length > 0) setEndpoints(list)
    }).catch(() => {
      // 失败静默：保留既有候选，不清空
    }).finally(() => {
      if (endpointSeqRef.current === seq) setEndpointsLoading(false)
    })
  }

  /** 候选过滤：输入值同时匹配 slug / name；未命中也可自由输入并提交（如 deepinfra/turbo 变体） */
  const endpointQuery = (draft.openRouterProvider ?? '').trim().toLowerCase()
  const endpointMatches = useMemo(() => {
    if (!endpointQuery) return endpoints
    return endpoints.filter(p => p.slug.toLowerCase().includes(endpointQuery) || p.name.toLowerCase().includes(endpointQuery))
  }, [endpoints, endpointQuery])

  /** 打开候选面板：按输入框实时位置定位（fixed 浮层 + portal，不受弹窗 overflow 裁剪）；无候选数据则不弹 */
  const openEndpointPanel = () => {
    const el = endpointInputRef.current
    if (!el || endpoints.length === 0) return
    const r = el.getBoundingClientRect()
    const H = 220, pad = 8
    const dropUp = window.innerHeight - r.bottom < H + 12 && r.top > H + 12
    setPanelPos({
      left: Math.max(pad, Math.min(r.left, window.innerWidth - r.width - pad)),
      width: r.width,
      top: dropUp ? r.top - 6 : r.bottom + 6,
      dropUp,
    })
    setPanelOpen(true)
  }

  // 面板打开期间：窗口尺寸/滚动（含弹窗内滚动）导致锚点漂移时直接收起，避免浮层错位
  useEffect(() => {
    if (!panelOpen) return
    const close = () => setPanelOpen(false)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [panelOpen])

  // 点击面板/输入框以外区域收起
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      // 刷新按钮同属面板交互区：点它若先收起面板，加载完也不会自动重开（用户观感＝刷新没生效）
      if (endpointPanelRef.current?.contains(t) || endpointInputRef.current?.contains(t) || endpointRefreshRef.current?.contains(t)) return
      setPanelOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [panelOpen])

  // ── 打开时初始化 + 拉取 OpenRouter 元数据 ──
  useEffect(() => {
    if (!open || !model) return
    setLocalModel(model)
    setDraft({
      maxContextTokens: model.maxContextTokens != null ? String(model.maxContextTokens) : '',
      temperature: model.temperature != null ? String(model.temperature) : '',
      maxOutputTokens: model.maxOutputTokens != null ? String(model.maxOutputTokens) : '',
      modelTypes: model.modelTypes && model.modelTypes.length > 0 ? [...model.modelTypes] : [],
      openRouterProvider: model.openRouterProvider,
    })
    setPriceEdits({})
    setCurrency('CNY')
    setError(null)
    setPanelOpen(false)
    // 固定服务商候选：打开时拉一次（未落地/失败 → 空列表，降级为纯文本）
    setEndpoints([])
    loadEndpoints()
    // spec §2.2：modelTypes 仅初始化为显式已存值；OR 命中项只作视觉预展示，不写入 draft（placeholder 永不落库）
    setTypesFromOr(!model.modelTypes || model.modelTypes.length === 0)
    let cancelled = false
    // 元数据单次查询：modelMetaLookup 为 providerModelMeta 的同源超集（均走 modelMetaRegistry.lookupMeta，
    // 含 contextLength/inputModalities + 4 维美元价）；matchedKey=null 时数据不可用（与旧 handler 返回 null 等价）
    window.electronAPI?.modelMetaLookup?.(model.name).then(r => {
      if (cancelled) return
      if (!r?.matchedKey) { setOrMeta(null); return }
      setOrMeta({
        contextLength: r.contextLength,
        inputModalities: r.inputModalities,
        inputPrice: r.inputPrice, outputPrice: r.outputPrice,
        cacheReadPrice: r.cacheReadPrice, cacheWritePrice: r.cacheWritePrice,
      })
    }).catch(() => {})
    return () => {
      cancelled = true
      // 使在途的候选请求失效（对齐 modelMetaLookup 的 cancelled 风格，此处靠 seq 递增）：
      // 弹窗关闭 / 切换模型后晚到的响应不再 setEndpoints / setEndpointsLoading
      endpointSeqRef.current++
      setEndpointsLoading(false)
      // 面板的 resize/scroll/mousedown 监听由各自的 [panelOpen] effect 清理（打开态卸载时同样触发）
    }
    // 依赖仅按模型身份（id）触发：父级 fillSingleRow 更新 model 对象引用时不得重跑，
    // 否则会静默重置 draft/priceEdits/currency（丢用户未提交编辑，spec final review Finding 2）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, model?.id])

  // OR 命中的模型类型（仅用于虚线框预展示，不入 draft）；用户手动点选后清空
  const orTypes = useMemo(() => {
    if (!typesFromOr || !orMeta?.inputModalities) return []
    return orMeta.inputModalities.map(modalityToType).filter((t): t is ModelType => t !== null)
  }, [orMeta?.inputModalities, typesFromOr])

  // ── placeholder / 样式来源（resolveModelParams 全应用唯一入口）──
  const resolved = useMemo(() => resolveModelParams(
    localModel ? {maxContextTokens: localModel.maxContextTokens, temperature: localModel.temperature, maxOutputTokens: localModel.maxOutputTokens} : undefined,
    {model: settingsDefaults},
    orMeta?.contextLength ?? 0,
  ), [localModel, settingsDefaults, orMeta?.contextLength])

  if (!open || !model || !localModel) return null

  /** 实时门禁：每次 render 由 validate 驱动，不依赖点击后才设置的 error state */
  const liveError = validateModelDetailDraft(draft)

  const sourceHint = (source: string) => {
    if (source === 'openrouter') return ''
    if (source === 'fallback') return '（兜底）'
    return '（系统设置）'
  }
  const sourceClass = (source: string) => (source === 'openrouter' ? 'border-dashed border-cyan-300 placeholder:text-cyan-700 placeholder:opacity-80' : 'placeholder:text-gray-400')

  const ctxPh = `${resolved.maxContextTokens.source === 'openrouter' || resolved.maxContextTokens.source === 'fallback' ? resolved.maxContextTokens.value : DEFAULT_MAX_CONTEXT_TOKENS}${sourceHint(resolved.maxContextTokens.source)}`
  const tempPh = `${resolved.temperature.value}${sourceHint(resolved.temperature.source)}`
  const outPh = `${resolved.maxOutputTokens.value}${sourceHint(resolved.maxOutputTokens.source)}`

  const curSymbol = currency === 'CNY' ? '￥' : '$'

  /**
   * 弹窗内派生价格格式化：统一保留小数点后 4 位去尾零。
   * 仅用于本弹窗的 placeholder / 反推提示等派生值；用户录入值（entered）保持逐字回显。
   */
  const formatDetailPrice = (v: number): string => {
    if (!Number.isFinite(v)) return ''
    const s = v.toFixed(4).replace(/\.?0+$/, '')
    return s === '' || s === '-' ? '0' : s
  }

  /** 价格单元格：value = raw（录入即真）→ displayEnteredCell 回显；placeholder = OpenRouter 折算值 */
  const priceCell = (f: PriceField) => {
    const raw = priceEdits[f]
    if (raw !== undefined) return {value: raw, placeholder: ''}
    const echo = displayEnteredCell(localModel.pricing, f, currency, rate)
    if (echo !== '') return {value: echo, placeholder: ''}
    const orKey = ({input: 'inputPrice', output: 'outputPrice', cacheRead: 'cacheReadPrice', cacheWrite: 'cacheWritePrice'} as const)[f]
    const orPrice = orMeta?.[orKey]
    if (typeof orPrice === 'number' && Number.isFinite(orPrice)) {
      return {value: '', placeholder: formatDetailPrice(tokenToPerM(orPrice) * (currency === 'CNY' ? rate : 1))}
    }
    return {value: '', placeholder: ''}
  }

  const reverseHint = (f: PriceField) => {
    const hint = reverseHintPrice(localModel.pricing, f, currency, rate, priceEdits[f])
    if (!hint) return null
    return `≈ ${hint.currency === 'CNY' ? '￥' : '$'}${formatDetailPrice(Number(hint.value))}`
  }

  const toggleType = (t: ModelType) => {
    setError(null)
    // 任何手动点击即退出 OR 预展示态（虚线 chip 消失），此后按自定义值切换。
    // 不并入 OR 命中集：OR 建议仅作视觉预展示，用户需逐个显式勾选才落库，
    // 避免首次点击意外把全部 OR 类型带入自定义（导致「取消一个」后红点仍亮）。
    setTypesFromOr(false)
    setDraft(prev => ({
      ...prev,
      modelTypes: prev.modelTypes.includes(t) ? prev.modelTypes.filter(x => x !== t) : [...prev.modelTypes, t],
    }))
  }

  const handleConfirm = () => {
    const err = validateModelDetailDraft(draft)
    if (err) { setError(err); return }
    // draft.modelTypes 仅含自定义值（OR 预展示不入 draft，未手动编辑则保持初始化值，OR 派生值不落库）
    // 价格折算（录入即真）：commitRow 返回 undefined = 无价（不注入 pricing）
    const pricing = commitRow(localModel.pricing, priceEdits, currency, rate)
    const next = commitModelDetail(localModel, draft)
    onConfirm({...next, pricing})
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} data-name="model-detail-modal">
      <div className="flex max-h-[92vh] w-[520px] flex-col overflow-hidden rounded-[14px] bg-white shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 pb-3 pt-4">
          <div>
            <h2 className="text-[15px] font-semibold text-gray-700">{providerName} / {model.name}</h2>
          </div>
          <button onClick={onClose} className="rounded-md px-1.5 py-0.5 leading-none text-gray-400 hover:bg-[var(--surface-overlay)] hover:text-gray-600 flex items-center" data-name="model-detail-modal-close"><RemoveIcon className="w-4 h-4"/></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* ── 静态配置 ── */}
          <div className="mb-2.5 mt-0 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-gray-400">
            静态配置
          </div>

          <div className="mb-3.5">
            <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-500">模型类型（可多选）
              <InfoTip><b className="font-semibold text-[var(--warning)]">多选。</b>默认按 OpenRouter 架构声明的输入模态勾选（青色虚线框）；手动增删后按自定义值落库。</InfoTip>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {MODEL_TYPES.map(t => {
                // 勾选态 = 自定义 draft 值 ∪ OR 预展示（orTypes 不入 draft，仅视觉）
                const on = draft.modelTypes.includes(t.value) || orTypes.includes(t.value)
                return (
                  <button key={t.value} onClick={() => toggleType(t.value)}
                    data-name={`model-detail-type-${t.value}`}
                    className={
                      'rounded-full border px-3 py-1 text-[11px] transition-colors ' +
                      (on
                        ? typesFromOr
                          ? 'border-dashed border-cyan-200 bg-cyan-50 font-semibold text-cyan-700'
                          : 'border-brand-300 bg-brand-50 font-semibold text-brand-600'
                        : 'border-gray-200 text-gray-500 hover:border-brand-300 hover:text-brand-500')
                    }>
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* OpenRouter 固定服务商：仅 Base URL 识别为 OpenRouter 时展示；留空 = 自动路由（不注入 provider 参数） */}
          {isOpenRouter && (
            <div className="mb-3.5">
              <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-500">固定服务商
                <InfoTip><b className="font-semibold text-[var(--warning)]">默认自动路由。</b>OpenRouter 按价格在多个服务商间负载均衡，同一模型可能落到不同服务商导致提示词缓存频繁失效；指定后缓存可持续命中。留空 = 自动路由。也可直接输入列表外的 slug 变体。</InfoTip>
              </div>
              <div className="relative">
                <input
                  ref={endpointInputRef}
                  type="text"
                  value={draft.openRouterProvider ?? ''}
                  onChange={e => {
                    // 留空即写回 undefined（自动路由）；其余原样透传（trim/空值由 modelDetailCommit 负责）
                    const v = e.target.value
                    setDraft(p => ({...p, openRouterProvider: v === '' ? undefined : v}))
                    openEndpointPanel()
                  }}
                  onFocus={openEndpointPanel}
                  placeholder="自动路由（不指定服务商）"
                  data-name="model-detail-openrouter-provider-input"
                  className={'w-full rounded-lg border border-gray-200 px-2.5 py-[7px] pr-9 text-[13px] text-gray-700 outline-none placeholder:text-gray-400 ' + INPUT_FOCUS}
                />
                <button type="button" ref={endpointRefreshRef} onClick={() => loadEndpoints(true)} disabled={endpointsLoading}
                  title="刷新服务商列表" data-name="model-detail-openrouter-provider-refresh"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition-colors hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40">
                  <RefreshIcon className={'w-3.5 h-3.5' + (endpointsLoading ? ' animate-spin' : '')}/>
                </button>
              </div>
            </div>
          )}

          {/* 价格区 */}
          <div className="mb-3.5">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500">价格（{curSymbol} / 百万 token）</label>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-[var(--text-secondary)]">按实时汇率 {formatPrice(rate)} 折算自 OpenRouter 美元价</span>
                <div className="flex overflow-hidden rounded-md border border-gray-200 text-[10px]">
                  {(['USD', 'CNY'] as Currency[]).map(c => (
                    <button key={c} onClick={() => setCurrency(c)} data-name={`model-detail-currency-${c}`}
                      className={'px-2 py-0.5 ' + (currency === c ? 'bg-brand-50 font-semibold text-brand-600' : 'text-gray-400 hover:text-gray-600')}>
                      {c === 'USD' ? '$ 美元' : '￥ 人民币'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {PRICE_FIELDS.map(({key, label}) => {
                const cell = priceCell(key)
                return (
                  <div key={key}>
                    <div className="mb-1 text-[10px] text-gray-400">{label}</div>
                    <div className="relative">
                      <input
                        value={cell.value}
                        onChange={e => { setError(null); setPriceEdits(prev => ({...prev, [key]: e.target.value})) }}
                        placeholder={cell.placeholder}
                        data-name={`model-detail-price-${key}`}
                        className={'w-full rounded-lg border border-gray-200 px-2.5 py-[7px] pr-6 text-right text-[13px] text-gray-700 outline-none ' + INPUT_FOCUS + ' ' +
                          (cell.placeholder ? 'border-dashed placeholder:text-cyan-700 placeholder:opacity-80' : '')}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-secondary)]">{curSymbol}</span>
                    </div>
                    <div className="mt-0.5 text-right text-[9px] text-[var(--text-secondary)]">{reverseHint(key)}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 分界线 */}
          <div className="my-4 flex items-center gap-2.5 before:block before:h-px before:flex-1 before:bg-gradient-to-r before:from-transparent before:to-gray-300 after:block after:h-px after:flex-1 after:bg-gradient-to-l after:from-transparent after:to-gray-300">
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] text-gray-400">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]"></span> 以下参数会写入实际 LLM 请求
            </span>
          </div>

          {/* ── 运行时参数 ── */}
          <div className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-gray-400">
            运行时参数 <span className="rounded-full bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-1.5 py-px text-[9px] font-medium tracking-normal text-[var(--warning)]">影响实际请求 · 填写才落库</span>
          </div>

          <div className="mb-3.5 grid grid-cols-3 gap-2.5">
            <div>
              <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-500">最大上下文 <span className="text-[10px] font-normal text-[var(--text-secondary)]">tokens</span>
                <InfoTip><b className="font-semibold text-[var(--warning)]">影响实际请求。</b>用于自动交接阈值判断。优先级：自定义填写 → OpenRouter 匹配 → 1M 兜底。</InfoTip>
              </div>
              <input value={draft.maxContextTokens} inputMode="numeric" placeholder={ctxPh}
                onChange={e => { setError(null); setDraft(p => ({...p, maxContextTokens: e.target.value})) }}
                data-name="model-detail-max-context"
                className={'w-full rounded-lg border border-gray-200 px-2.5 py-[7px] text-[13px] text-gray-700 outline-none ' + INPUT_FOCUS + ' ' + sourceClass(resolved.maxContextTokens.source)} />
              {resolved.maxContextTokens.source !== 'openrouter' && (
                <div className="mt-1 text-[10px] leading-snug text-[var(--text-secondary)]">无匹配兜底 {DEFAULT_MAX_CONTEXT_TOKENS}</div>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-500">温度 <span className="text-[10px] font-normal text-[var(--text-secondary)]">0–2</span>
                <InfoTip><b className="font-semibold text-[var(--warning)]">影响实际请求。</b>采样温度。优先级：自定义填写 → 系统设置「默认温度」。推理模型自动忽略此参数。</InfoTip>
              </div>
              <input value={draft.temperature} inputMode="decimal" placeholder={tempPh}
                onChange={e => { setError(null); setDraft(p => ({...p, temperature: e.target.value})) }}
                data-name="model-detail-temperature"
                className={'w-full rounded-lg border border-gray-200 px-2.5 py-[7px] text-[13px] text-gray-700 outline-none ' + INPUT_FOCUS + ' ' + sourceClass(resolved.temperature.source)} />
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-500">最大输出 <span className="text-[10px] font-normal text-[var(--text-secondary)]">tokens</span>
                <InfoTip><b className="font-semibold text-[var(--warning)]">影响实际请求。</b>单次响应输出上限，超限被截断。优先级：自定义填写 → 系统设置「默认最大 Token 数」。</InfoTip>
              </div>
              <input value={draft.maxOutputTokens} inputMode="numeric" placeholder={outPh}
                onChange={e => { setError(null); setDraft(p => ({...p, maxOutputTokens: e.target.value})) }}
                data-name="model-detail-max-output"
                className={'w-full rounded-lg border border-gray-200 px-2.5 py-[7px] text-[13px] text-gray-700 outline-none ' + INPUT_FOCUS + ' ' + sourceClass(resolved.maxOutputTokens.source)} />
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
          <span className="max-w-[260px] text-[10px] leading-relaxed text-[var(--text-secondary)]">
            {(error ?? liveError) && <span className="text-[var(--error)]">{error ?? liveError}</span>}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} data-name="model-detail-cancel" className="rounded-lg px-3.5 py-[7px] text-[13px] text-gray-500 hover:bg-[var(--surface-overlay)]">取消</button>
            <button onClick={handleConfirm} disabled={liveError !== null} data-name="model-detail-confirm"
              className="rounded-lg bg-brand-500 px-[18px] py-[7px] text-[13px] font-medium text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40">确定</button>
          </div>
        </div>
      </div>

      {/* 服务商候选浮层：portal + fixed，脱离弹窗 overflow/圆角裁剪（与 InfoTip 同策略，更稳的 portal 变体） */}
      {panelOpen && panelPos && createPortal(
        <div ref={endpointPanelRef} role="listbox" data-name="model-detail-openrouter-provider-panel"
          className="z-[100002] max-h-[220px] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1.5 shadow-2xl"
          style={{
            position: 'fixed',
            left: panelPos.left,
            width: panelPos.width,
            top: panelPos.dropUp ? undefined : panelPos.top,
            bottom: panelPos.dropUp ? window.innerHeight - panelPos.top : undefined,
          }}>
          {endpointMatches.map(ep => (
            <button key={ep.slug} type="button"
              onMouseDown={e => {
                e.preventDefault()   // 阻止输入框失焦，避免闪烁
                setDraft(p => ({...p, openRouterProvider: ep.slug}))
                setPanelOpen(false)
              }}
              className={'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--surface-muted)] ' +
                (draft.openRouterProvider === ep.slug ? 'bg-brand-50' : '')}
              data-name={`model-detail-openrouter-provider-option-${ep.slug}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-gray-700">{ep.name}</span>
                <span className="block truncate text-[10px] text-[var(--text-secondary)]">{ep.slug}</span>
              </span>
              {typeof ep.uptimeLast30m === 'number' && (
                <span className={`shrink-0 text-[9px] font-medium ${
                  ep.uptimeLast30m >= 99.7 ? 'text-emerald-600'
                    : ep.uptimeLast30m < 99.0 ? 'text-[var(--warning)]'
                    : 'text-[var(--text-secondary)]'
                }`}>{ep.uptimeLast30m.toFixed(1)}%</span>
              )}
            </button>
          ))}
          {endpointMatches.length === 0 && (
            <div className="px-2.5 py-2 text-center text-[10px] text-[var(--text-secondary)]">未匹配到候选服务商，可直接输入 slug</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
