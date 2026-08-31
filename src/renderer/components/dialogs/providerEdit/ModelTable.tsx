import type {ProviderModel} from '@shared/types'
import type {Currency} from '@shared/pricing'
import {displayPrice, parsePriceInput} from '../../../lib/priceEditing'
import {useState, type MouseEvent} from 'react'

interface TestState {
  status: 'testing' | 'ok' | 'fail'
  error?: string
  latencyMs?: number
}

type PriceField = 'input' | 'output' | 'cacheRead' | 'cacheWrite'

interface ModelTableProps {
  models: ProviderModel[]
  currency: Currency
  rate: number
  rateDate: string | null
  /** 汇率拉取未就绪（USD+rate=1 恒等窗口）：锁定价格输入与货币切换，避免编辑串货币归属歧义 */
  rateLoading: boolean
  /** 行内编辑状态：rowId → 字段 → 用户原始输入串 */
  edits: Record<string, Partial<Record<PriceField, string>>>
  onEditCell: (rowId: string, field: PriceField, raw: string) => void
  /** 工具栏货币切换（USD ↔ CNY；汇率折算与落盘由父级在保存时统一处理） */
  onCurrencyChange: (cur: Currency) => void
  /** 以 OpenRouter 元数据回填该行空缺价格（Task 11 接线；T9 允许 no-op） */
  onFillRow: (modelId: string) => Promise<void>
  /** 表头「填充」：逐行全表回填空缺价格（无空缺行报告「无空缺」并保持不动） */
  onFillAll: () => Promise<void>
  testStates: Record<string, TestState>
  canTest: boolean
  credentialBlockReason: string
  batchTesting: boolean
  batchProgress: {done: number; total: number} | null
  /** 工具栏右侧插槽（父级放置「自动获取」等外部依赖按钮） */
  toolbarExtra?: React.ReactNode
  onNameChange: (id: string, name: string) => void
  onTest: (modelId: string, modelName: string) => void
  onTestAll: () => void
  onCancelBatch: () => void
  onDelete: (id: string) => void
  onAdd: (name?: string) => void
}

const PRICE_COLUMNS: Array<{field: PriceField; label: string}> = [
  {field: 'input', label: '输入价'},
  {field: 'output', label: '输出价'},
  {field: 'cacheRead', label: '缓存读'},
  {field: 'cacheWrite', label: '缓存写'},
]

const CURRENCY_SYMBOL: Record<Currency, string> = {USD: '$', CNY: '￥'}

const TYPE_LABEL: Record<string, string> = {
  text: '文本', image: '图像', voice: '音频', video: '视频', music: '音乐', embedding: '向量',
}

/** 复制测试错误信息 */
const copyError = async (text: string | undefined) => {
  if (!text) return
  try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用时静默 */ }
}

/**
 * 模型管理表（设计 §三 B4）：
 * 列 = 模型 ID ｜ 类型徽标 ｜ 4 价格输入框 ｜ 填充 ｜ 测试 ｜ 删除。
 * 无启用开关列——使用哪个模型由模型方案角色引用决定；新增行固定 enabled:true，
 * 存量行 enabled 值由父级透传，本组件不读写。
 */
export default function ModelTable({
  models,
  currency,
  rate,
  rateDate,
  rateLoading,
  edits,
  onEditCell,
  onCurrencyChange,
  onFillRow,
  onFillAll,
  testStates,
  canTest,
  credentialBlockReason,
  batchTesting,
  batchProgress,
  toolbarExtra,
  onNameChange,
  onTest,
  onTestAll,
  onCancelBatch,
  onDelete,
  onAdd,
}: ModelTableProps) {
  const sym = CURRENCY_SYMBOL[currency]
  // 测试失败错误包 tips：fixed 定位（锚点 rect），避免被表格 overflow-x-auto 容器裁剪
  const [errTip, setErrTip] = useState<{x: number; y: number; error?: string} | null>(null)
  const openErrTip = (e: MouseEvent<HTMLSpanElement>, error?: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setErrTip({x: r.left + r.width / 2, y: r.bottom, error})
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-gray-500">模型列表<span className="ml-1.5 text-[10px] font-normal text-gray-400">价格允许为空</span></label>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-400">{models.length} 个模型</span>
          {/* 汇率参考：date 为 null 表示主进程未同步（使用兜底汇率） */}
          <span className="text-[9px] text-gray-300" title="价格换算参考汇率（CNY/USD）">
            {rateDate ? `汇率 ${rate}（${rateDate}）` : `汇率 ${rate} · 未同步`}
          </span>
          {/* 货币切换段（§三 B5）：展示货币切换，仅影响展示与本次编辑折算 */}
          <div className="flex items-center rounded border border-gray-200 overflow-hidden text-[10px]">
            {(['USD', 'CNY'] as Currency[]).map(cur => (
              <button key={cur} onClick={() => onCurrencyChange(cur)} disabled={rateLoading}
                title={rateLoading ? '汇率加载中…' : undefined}
                className={`px-1.5 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  currency === cur ? 'bg-brand-50 text-brand-600 font-medium' : 'bg-white text-gray-400 hover:text-gray-600'
                }`}>
                {cur === 'USD' ? '$ 美元' : '￥ 人民币'}
              </button>
            ))}
          </div>
          {batchTesting ? (
            <button onClick={onCancelBatch}
              className="flex items-center gap-1 text-[10px] font-medium text-orange-500 hover:text-orange-600 transition-colors">
              {batchProgress ? `测试中 ${batchProgress.done}/${batchProgress.total} · 取消` : '测试中...'}
            </button>
          ) : (
            <button onClick={onTestAll} disabled={models.filter(m => m.name.trim()).length === 0 || !canTest}
              title={!canTest ? credentialBlockReason : '测试全部模型'}
              className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              测试全部
            </button>
          )}
          {toolbarExtra}
        </div>
      </div>

      {/* 表格容器：窄窗口横向滚动兜底 */}
      <div className="border border-gray-100 rounded-md overflow-x-auto mb-2">
        <table className="w-full border-collapse text-[11px] min-w-[640px]">
          <thead>
            <tr className="bg-gray-50/50 text-left">
              <th className="px-2 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap">模型 ID</th>
              <th className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[52px]">类型</th>
              {PRICE_COLUMNS.map(c => (
                <th key={c.field} className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[76px]">
                  {c.label}(<span>{sym}</span>/M)
                </th>
              ))}
              <th className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[40px]">
                <button onClick={() => { void onFillAll() }} disabled={batchTesting}
                  title="逐行按模型 ID 查询 OpenRouter 元数据，回填空缺的价格列（已有价格不覆盖）"
                  className="inline-flex items-center gap-0.5 text-gray-300 hover:text-brand-500 disabled:opacity-30 transition-colors">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M19 12l-7 7-7-7"/>
                  </svg>
                  填充
                </button>
              </th>
              <th className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[40px]">测试</th>
              <th className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[32px]">删除</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-gray-400 text-[11px] py-6">
                  暂无模型 · 点击手动添加或从服务商拉取开始
                </td>
              </tr>
            )}
            {models.map((model, i) => {
              const isEmpty = !model.name.trim()
              const isDuplicate = !isEmpty && models.some((m, j) => j !== i && m.name.trim().toLowerCase() === model.name.trim().toLowerCase())
              const ts = testStates[model.id]
              return (
                <tr key={model.id} className="border-t border-gray-100">
                  {/* 模型 ID */}
                  <td className="px-2 py-1">
                    <input type="text" value={model.name} placeholder="模型名称"
                      onChange={(e) => onNameChange(model.id, e.target.value)}
                      className={`w-full px-2 py-1 text-[11px] font-mono bg-white border rounded text-gray-700 focus:outline-none placeholder-gray-400 ${
                        isEmpty || isDuplicate ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                      }`} />
                  </td>
                  {/* 类型徽标（hover 显示识别来源说明） */}
                  <td className="px-1 py-1">
                    <span
                      className="inline-block max-w-full px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[9px] whitespace-nowrap"
                      title={`类型：${TYPE_LABEL[model.modelType || 'text'] || model.modelType || 'text'}\n识别来源：拉取时按模型 ID 命名规则推断；填充命中 OpenRouter 元数据后按输入模态更新`}
                    >{TYPE_LABEL[model.modelType || 'text'] || model.modelType || 'text'}</span>
                  </td>
                  {/* 4 价格输入框：货币符号随 currency；值 = 编辑串或存储价折算展示；下方 ≈ 反向参考值 */}
                  {PRICE_COLUMNS.map(({field}) => {
                    const raw = edits[model.id]?.[field]
                    const hasRaw = raw !== undefined && raw.trim() !== ''
                    // 反向参考基准（USD/token）：有用户输入按当前货币解析；否则用存储原值
                    const usdToken = hasRaw ? parsePriceInput(raw as string, currency, rate) : model.pricing?.[field]
                    const hint = usdToken !== undefined
                      ? displayPrice(usdToken, currency === 'USD' ? 'CNY' : 'USD', rate)
                      : null
                    return (
                      <td key={field} className="px-1 py-1">
                        <input type="text" inputMode="decimal"
                          value={raw ?? displayPrice(model.pricing?.[field], currency, rate)}
                          onChange={(e) => onEditCell(model.id, field, e.target.value)}
                          disabled={rateLoading}
                          placeholder="—"
                          title={rateLoading ? '汇率加载中…' : undefined}
                          className="w-full min-w-0 px-1 py-1 text-[11px] text-right bg-white border border-gray-200 rounded text-gray-700 placeholder-gray-300 focus:outline-none focus:border-brand-300 disabled:opacity-40 disabled:cursor-not-allowed" />
                        {hint && (
                          <div className="text-[9px] text-gray-300 text-right leading-tight select-none">
                            ≈ {currency === 'USD' ? '￥' : '$'}{hint}
                          </div>
                        )}
                      </td>
                    )
                  })}
                  {/* 填充：以 OpenRouter 元数据回填空缺价格（接线见 Task 11） */}
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => { void onFillRow(model.id) }}
                      disabled={batchTesting}
                      title="按模型 ID 查询 OpenRouter 元数据，回填空缺的价格列（已有价格不覆盖）"
                      className="p-1 text-gray-300 hover:text-brand-500 disabled:opacity-30 transition-colors">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M19 12l-7 7-7-7"/>
                      </svg>
                    </button>
                  </td>
                  {/* 测试态：spinner / ✔+延迟 / ✖+完整错误 tips（含复制） */}
                  <td className="px-1 py-1 text-center">
                    {ts?.status === 'testing' ? (
                      <span className="inline-block w-3 h-3 border-2 border-brand-300 border-t-transparent rounded-full animate-spin" />
                    ) : ts?.status === 'ok' ? (
                      <span className="text-green-500 text-[11px] whitespace-nowrap" title={`通过 · ${ts.latencyMs}ms`}>✔{ts.latencyMs != null && <span className="text-[9px] text-gray-400 ml-0.5">{ts.latencyMs}ms</span>}</span>
                    ) : ts?.status === 'fail' ? (
                      <span className="inline-block"
                        onMouseEnter={(e) => openErrTip(e, ts.error)}
                        onMouseLeave={() => setErrTip(null)}>
                        <span className="text-red-500 text-[11px] cursor-help">✖</span>
                        {errTip && (
                          <span className="fixed z-50 w-64 rounded-lg bg-gray-800 text-gray-100 text-[10px] leading-relaxed text-left shadow-lg"
                            style={{left: errTip.x, top: errTip.y - 2, transform: 'translateX(-50%)', paddingTop: 2}}>
                            {/* paddingTop 作为桥接区，避免锚点与内容间鼠标穿越闪烁 */}
                            <span className="block p-2">
                              <b className="block text-red-300 mb-1">测试失败</b>
                              <span className="block max-h-24 overflow-y-auto break-all bg-white/10 rounded p-1 mb-1.5 font-mono text-gray-200">{errTip.error || '未知错误'}</span>
                              <button onClick={() => { void copyError(errTip.error) }}
                                className="border border-white/25 rounded px-1.5 py-0.5 text-[9px] hover:bg-white/10">复制错误信息</button>
                            </span>
                          </span>
                        )}
                      </span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); onTest(model.id, model.name) }}
                        disabled={batchTesting || !canTest || !model.name.trim()}
                        title={!model.name.trim() ? '请先填写模型名称' : !canTest ? credentialBlockReason : '测试此模型'}
                        className="p-1 text-gray-300 hover:text-brand-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      </button>
                    )}
                  </td>
                  {/* 删除 */}
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => onDelete(model.id)}
                      className="p-1 text-gray-300 hover:text-red-400 transition-colors" title="删除">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                      </svg>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 名称校验错误（表格下方汇总，避免窄列溢出） */}
      {models.some((m, i) => {
        const empty = !m.name.trim()
        const dup = !empty && models.some((n, j) => j !== i && n.name.trim().toLowerCase() === m.name.trim().toLowerCase())
        return empty || dup
      }) && (
        <div className="text-[10px] text-red-400 mb-2">存在未填写或重复的模型名称</div>
      )}

      {/* "+" button to add model（新增行固定 enabled: true） */}
      <button onClick={() => onAdd()}
        className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 transition-colors">
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        添加模型
      </button>
    </div>
  )
}
