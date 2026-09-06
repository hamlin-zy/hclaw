import type {ProviderModel} from '@shared/types'
import {hasCustomParams} from '@shared/modelParams'
import {useState, type MouseEvent} from 'react'

interface TestState {
  status: 'testing' | 'ok' | 'fail'
  error?: string
  latencyMs?: number
}

interface ModelTableProps {
  models: ProviderModel[]
  testStates: Record<string, TestState>
  canTest: boolean
  credentialBlockReason: string
  batchTesting: boolean
  batchProgress: {done: number; total: number} | null
  /** 工具栏右侧插槽（父级放置「自动获取」等外部依赖按钮） */
  toolbarExtra?: React.ReactNode
  /** 打开模型详情弹窗（⚙️ 详情列，参数配置在详情弹窗内完成） */
  onOpenDetail: (modelId: string) => void
  onNameChange: (id: string, name: string) => void
  onTest: (modelId: string, modelName: string, temperature?: number) => void
  onTestAll: () => void
  onCancelBatch: () => void
  onDelete: (id: string) => void
  onAdd: (name?: string) => void
}


/** 复制测试错误信息 */
const copyError = async (text: string | undefined) => {
  if (!text) return
  try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用时静默 */ }
}

/** 24x24 stroke 齿轮（与项目现有 svg 图标 stroke 风格一致） */
function GearIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.09a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h.09a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.09a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  )
}

/**
 * 模型管理表（设计 §三 B4 瘦身版）：
 * 列 = 模型 ID ｜ 详情(⚙️) ｜ 测试 ｜ 删除。
 * 类型徽标与价格编辑、参数配置均迁往模型详情弹窗（onOpenDetail）。
 * 无启用开关列——使用哪个模型由模型方案角色引用决定；新增行固定 enabled:true，
 * 存量行 enabled 值由父级透传，本组件不读写。
 */
export default function ModelTable({
  models,
  testStates,
  canTest,
  credentialBlockReason,
  batchTesting,
  batchProgress,
  toolbarExtra,
  onOpenDetail,
  onNameChange,
  onTest,
  onTestAll,
  onCancelBatch,
  onDelete,
  onAdd,
}: ModelTableProps) {
  // 测试失败错误包 tips：fixed 定位（锚点 rect），避免被表格 overflow-x-auto 容器裁剪
  const [errTip, setErrTip] = useState<{x: number; y: number; error?: string} | null>(null)
  const openErrTip = (e: MouseEvent<HTMLSpanElement>, error?: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setErrTip({x: r.left + r.width / 2, y: r.bottom, error})
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-gray-500">模型列表</label>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-400">{models.length} 个模型</span>
          {batchTesting ? (
            <button onClick={onCancelBatch}
              className="flex items-center gap-1 text-[10px] font-medium text-orange-500 hover:text-orange-600 transition-colors" data-name="model-table-cancel-batch-button">
              {batchProgress ? `测试中 ${batchProgress.done}/${batchProgress.total} · 取消` : '测试中...'}
            </button>
          ) : (
            <button onClick={onTestAll} disabled={models.filter(m => m.name.trim()).length === 0 || !canTest}
              title={!canTest ? credentialBlockReason : '测试全部模型'}
              className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" data-name="model-table-test-all-button">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              测试全部
            </button>
          )}
          {toolbarExtra}
        </div>
      </div>

      {/* 表格容器：窄窗口横向滚动兜底 */}
      <div className="border border-gray-100 rounded-md overflow-x-auto mb-2">
        <table className="w-full border-collapse text-[11px] min-w-[340px]">
          <thead>
            <tr className="bg-gray-50/50 text-left">
              <th className="px-2 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap">模型 ID</th>
              <th className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[40px] text-center">详情</th>
              <th className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[40px]">测试</th>
              <th className="px-1 py-1.5 font-medium text-gray-400 text-[10px] whitespace-nowrap w-[32px]">删除</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-gray-400 text-[11px] py-6">
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
                      }`} data-name="model-table-input"/>
                  </td>
                  {/* 详情：⚙️ 打开模型详情弹窗；已配置自定义参数时橙点提示 */}
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => onOpenDetail(model.id)}
                      title="模型详情与参数配置"
                      className="relative p-1 text-gray-300 hover:text-brand-500 transition-colors" data-name="model-table-detail-button">
                      <GearIcon />
                      {hasCustomParams(model) && (
                        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-orange-500 border border-white" />
                      )}
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
                                className="border border-white/25 rounded px-1.5 py-0.5 text-[9px] hover:bg-white/10" data-name="model-table-copy-error-button">复制错误信息</button>
                            </span>
                          </span>
                        )}
                      </span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); onTest(model.id, model.name, model.temperature ?? undefined) }}
                        disabled={batchTesting || !canTest || !model.name.trim()}
                        title={!model.name.trim() ? '请先填写模型名称' : !canTest ? credentialBlockReason : '测试此模型'}
                        className="p-1 text-gray-300 hover:text-brand-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" data-name="model-table-test-model-button">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      </button>
                    )}
                  </td>
                  {/* 删除 */}
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => onDelete(model.id)}
                      className="p-1 text-gray-300 hover:text-red-400 transition-colors" title="删除" data-name="model-table-delete-model-button">
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
        className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 transition-colors" data-name="model-table-add-model-button">
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        添加模型
      </button>
    </div>
  )
}
