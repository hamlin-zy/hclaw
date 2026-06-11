import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {type LLMProvider, useLLMStore} from '../../stores/llmStore'
import ProviderEditModal from './ProviderEditModal'

export default function LLMConfigDialog() {
  const { providers, activeProviderId, addProvider, updateProvider, removeProvider, setActiveProvider } = useLLMStore()
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)

  const editingProvider = useMemo(
    () => providers.find(p => p.id === editingProviderId) || null,
    [providers, editingProviderId]
  )

  const handleAdd = useCallback(async (data: any) => {
    await addProvider(data)
  }, [addProvider])

  const handleEdit = useCallback(async (data: any) => {
    if (editingProviderId) {
      await updateProvider(editingProviderId, data)
    }
  }, [editingProviderId, updateProvider])

  return (
    <div className="h-full overflow-y-auto">
      {/* 粘性标题栏 */}
      <div className="sticky top-0 z-10 bg-[var(--surface)] px-4 py-3 border-b border-[var(--border-muted)] flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">已配置的服务商</h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-3 py-1.5 text-xs font-medium text-brand-500 bg-brand-50 hover:bg-brand-100 rounded-md transition-colors"
        >
          + 添加
        </button>
      </div>

      {/* Provider 网格 */}
      <div className="p-4">
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isActive={activeProviderId === provider.id}
              onSelect={() => setActiveProvider(provider.id)}
              onEdit={() => setEditingProviderId(provider.id)}
              onRemove={() => removeProvider(provider.id)}
            />
          ))}
        </div>

        {providers.length === 0 && (
          <div className="text-center py-16">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gray-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a10 10 0 0110 10c0 4.5-3 8.3-7 9.6V20a2 2 0 00-2 2h-2a2 2 0 00-2-2v-1.4C5 20.3 2 16.5 2 12A10 10 0 0112 2z" />
                <path d="M8 12h8M12 8v8" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-500">暂无已配置的服务商</p>
            <p className="text-xs text-gray-400 mt-1">点击上方"添加"按钮开始配置</p>
          </div>
        )}
      </div>

      {/* 添加弹窗 */}
      <AnimatePresence>
        {showAddModal && (
          <ProviderEditModal
            mode="add"
            onClose={() => setShowAddModal(false)}
            onSave={handleAdd}
          />
        )}
      </AnimatePresence>

      {/* 编辑弹窗 */}
      <AnimatePresence>
        {editingProvider && (
          <ProviderEditModal
            mode="edit"
            provider={editingProvider}
            onClose={() => setEditingProviderId(null)}
            onSave={handleEdit}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── ProviderCard ────────────────────────────────────────────────────────────

function ProviderCard({ provider, isActive, onSelect, onEdit, onRemove }: {
  provider: LLMProvider; isActive: boolean
  onSelect: () => void; onEdit: () => void; onRemove: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [modelsExpanded, setModelsExpanded] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const modelsContainerRef = useRef<HTMLDivElement>(null)
  const allModels = provider.models

  const sortedModels = useMemo(() => {
    return [...allModels].sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1))
  }, [allModels])

  useEffect(() => {
    if (!modelsContainerRef.current) return
    setHasOverflow(modelsContainerRef.current.scrollHeight > modelsContainerRef.current.clientHeight)
  }, [sortedModels])

  const isOAuth2Expired = useMemo(() => {
    const expiryDate = provider.credentials?.expiryDate
    return provider.authType === 'google-oauth2' && expiryDate && Date.now() > expiryDate
  }, [provider.authType, provider.credentials?.expiryDate])

  const authStatusText = useMemo(() => {
    if (provider.authType !== 'google-oauth2') {
      return provider.credentials?.apiKey ? ' · 已配置' : ''
    }
    const expiryDate = provider.credentials?.expiryDate
    if (!expiryDate) return ' · 未授权'
    return Date.now() > expiryDate ? ' · 授权已过期' : ' · 已授权'
  }, [provider.authType, provider.credentials])

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className={`rounded-lg transition-all duration-150 cursor-pointer ${
        isActive
          ? 'bg-[var(--brand-muted)] border border-[var(--brand-border)] shadow-subtle'
          : 'bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--border-emphasis)] hover:shadow-subtle'
      }`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect() }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 pb-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* 状态指示灯 */}
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            isOAuth2Expired ? 'bg-orange-400' : provider.enabled ? 'bg-green-400' : 'bg-gray-300'
          }`} aria-label={provider.enabled ? '已启用' : '已禁用'} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-800 truncate leading-tight">{provider.name}</div>
            <div className="text-xs text-gray-500 mt-0.5 leading-tight">
              {provider.models.filter(m => m.enabled).length}/{provider.models.length} 个模型{authStatusText}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* 编辑按钮 */}
          <button
            onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-brand-500 rounded-md hover:bg-gray-100 transition-colors"
            title="编辑"
            aria-label={`编辑 ${provider.name}`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </button>
          {/* 删除区域 */}
          {confirmRemove ? (
            <div className="flex items-center gap-0.5">
              <button
                onClick={onRemove}
                className="px-1.5 py-1 text-[10px] font-medium text-white bg-red-500 rounded hover:bg-red-600 transition-colors"
              >
                确认
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="px-1.5 py-1 text-[10px] text-gray-500 hover:text-gray-700 transition-colors"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-gray-100 transition-colors"
              title="删除"
              aria-label={`删除 ${provider.name}`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Model 列表 */}
      {allModels.length > 0 && (
        <div className="p-3 pb-2.5">
          <div className="pt-2.5 border-t border-gray-100">
            {/* 模型徽章 */}
            <div className="relative overflow-hidden">
              <div
                ref={modelsContainerRef}
                className={`flex flex-wrap gap-1.5 ${modelsExpanded ? '' : 'max-h-[26px] overflow-hidden'}`}
              >
                {sortedModels.map((model) => (
                  <span
                    key={model.id}
                    className={`inline-flex items-center px-2 py-0.5 text-[11px] leading-tight rounded-md border whitespace-nowrap ${
                      model.enabled
                        ? 'bg-gray-50 text-gray-600 border-gray-200'
                        : 'bg-gray-50/50 text-gray-400 border-gray-100'
                    }`}
                  >
                    {model.name}
                  </span>
                ))}
              </div>
            </div>

            {/* 展开/折叠 */}
            {(hasOverflow || modelsExpanded) && (
              <button
                onClick={(e) => { e.stopPropagation(); setModelsExpanded(!modelsExpanded) }}
                className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform duration-150 ${modelsExpanded ? 'rotate-180' : ''}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                {modelsExpanded ? '收起' : `展开全部 (${sortedModels.length})`}
              </button>
            )}
          </div>
        </div>
      )}
    </motion.div>
  )
}
