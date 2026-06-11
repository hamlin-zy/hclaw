import {useEffect, useRef, useState} from 'react'
import {Switch} from '../common/Switch'
import type {HookEventDefinition} from '../../stores/hookStore'
import {type Hook, type HookConfig, useHookStore} from '../../stores/hookStore'
import {confirm} from '../ConfirmDialog'

type HookType = 'command' | 'prompt' | 'http' | 'agent'

// 渲染进程不可用 process.platform，通过 userAgent 判断
const IS_WIN = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

const CATEGORY_ORDER = ['session', 'tool', 'agent', 'mcp', 'file', 'permission', 'task', 'response'] as const
type Category = typeof CATEGORY_ORDER[number]

const CATEGORY_LABELS: Record<Category, string> = {
  session: '会话',
  tool: '工具',
  agent: 'Agent',
  mcp: 'MCP',
  file: '文件',
  permission: '权限',
  task: '任务',
  response: '响应'
}

const TYPE_LABELS: Record<HookType, string> = {
  command: '命令',
  prompt: '提示词',
  http: 'HTTP 请求',
  agent: 'Agent'
}

export default function HooksDialog() {
  const { hooks, eventDefinitions, fetchHooks, fetchEventDefinitions, saveHook, deleteHook, toggleHook } = useHookStore()
  const [selectedCategory, setSelectedCategory] = useState<Category>('session')
  const [isCreating, setIsCreating] = useState(false)
  const [editingHook, setEditingHook] = useState<Hook | null>(null)
  const [toast, setToast] = useState<{type: 'success' | 'error'; text: string} | null>(null)

  useEffect(() => {
    fetchHooks()
    fetchEventDefinitions()
  }, [fetchHooks, fetchEventDefinitions])

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  // 按类别分组
  const hooksByCategory = CATEGORY_ORDER.reduce((acc, cat) => {
    acc[cat] = hooks.filter(h => {
      const def = eventDefinitions.find(d => d.event === h.events[0])
      return def?.category === cat
    })
    return acc
  }, {} as Record<Category, Hook[]>)

  const currentHooks = hooksByCategory[selectedCategory] || []
  const categoryDef = eventDefinitions.find(d => d.category === selectedCategory)

  const handleSave = async (data: Partial<Hook> & { name: string; events: string[]; config: HookConfig }) => {
    const result = await saveHook({
      id: editingHook?.id || `hook-${Date.now()}`,
      name: data.name,
      description: data.description || '',
      events: data.events,
      config: data.config,
      enabled: data.enabled ?? true,
      source: 'user',
      createdAt: editingHook?.createdAt || Date.now(),
      updatedAt: Date.now()
    } as any)

    if (result.success) {
      setToast({type: 'success', text: `Hook "${data.name}" 已保存`})
      setIsCreating(false)
      setEditingHook(null)
    } else {
      setToast({type: 'error', text: `保存失败: ${result.error || '未知错误'}`})
    }
  }

  const handleDelete = async (id: string) => {
      const confirmed = await confirm({
          title: '确认删除',
          message: '确定要删除这个 Hook 吗？此操作无法撤销。',
          confirmText: '删除',
          confirmVariant: 'danger',
          onConfirm: async () => {
              await deleteHook(id)
          }
      })
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Hooks 管理</h3>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">在关键事件发生时自动执行操作</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">{hooks.length} 个 Hooks</span>
          <button
            onClick={() => { setIsCreating(true); setEditingHook(null) }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20 transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            创建
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`mx-4 mt-2 px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2 ${
          toast.type === 'success'
            ? 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20'
            : 'bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/20'
        }`}>
          {toast.type === 'success' ? (
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          ) : (
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          )}
          <span className="flex-1">{toast.text}</span>
          <button onClick={() => setToast(null)} className="opacity-60 hover:opacity-100">&times;</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - Category Navigation */}
        <div className="w-36 border-r border-[var(--border)] bg-[var(--surface-muted)]/30 overflow-y-auto">
          {CATEGORY_ORDER.map(cat => {
            const count = hooksByCategory[cat]?.length || 0
            const hasDefs = eventDefinitions.some(d => d.category === cat)
            if (!hasDefs) return null

            return (
              <button
                key={cat}
                onClick={() => { setSelectedCategory(cat); setIsCreating(false); setEditingHook(null) }}
                className={`w-full px-3 py-2 flex items-center justify-between text-xs transition-all border-b border-[var(--border)] ${
                  selectedCategory === cat
                    ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                }`}
              >
                <span className="font-medium">{CATEGORY_LABELS[cat]}</span>
                {count > 0 && (
                  <span className={`px-1.5 py-0.5 rounded text-[9px] ${
                    selectedCategory === cat ? 'bg-[var(--brand-primary)]/20' : 'bg-[var(--surface-muted)]'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {isCreating || editingHook ? (
            <HookEditor
              key={editingHook?.id || 'new-hook'}
              hook={editingHook}
              eventDefinitions={eventDefinitions.filter(d => d.category === selectedCategory)}
              onSave={handleSave}
              onCancel={() => { setIsCreating(false); setEditingHook(null) }}
            />
          ) : (
            <HookList
              hooks={currentHooks}
              eventDefinitions={eventDefinitions.filter(d => d.category === selectedCategory)}
              onEdit={(hook) => { setEditingHook(hook); setIsCreating(false) }}
              onDelete={handleDelete}
              onToggle={(id, enabled) => toggleHook(id, enabled)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// Hook List Component — 点击卡片展开详情 inline
function HookList({ hooks, eventDefinitions, onEdit, onDelete, onToggle }: {
  hooks: Hook[]
  eventDefinitions: HookEventDefinition[]
  onEdit: (hook: Hook) => void
  onDelete: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (hooks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <svg className="w-12 h-12 text-[var(--text-muted)]/30 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <p className="text-sm text-[var(--text-muted)]">暂无 Hooks</p>
        <p className="text-xs text-[var(--text-muted)]/70 mt-1">在左侧选择一个类别开始创建</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-medium mb-3">
        {hooks.length} 个 Hook
      </div>
      {hooks.map(hook => {
        const def = eventDefinitions.find(d => d.event === hook.events[0])
        const isPlugin = hook.source === 'plugin'
        const isExpanded = expandedId === hook.id
        const config = hook.config as any

        return (
          <div
            key={hook.id}
            className={`rounded-xl border transition-all bg-[var(--surface)] ${
              isExpanded
                ? 'border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5 shadow-sm ring-1 ring-[var(--brand-primary)]/10'
                : 'border-[var(--border)] hover:border-[var(--border-muted)]'
            }`}
          >
            {/* Card Header — 点击展开/收起 */}
            <div
              className="p-3 cursor-pointer group"
              onClick={() => setExpandedId(isExpanded ? null : hook.id)}
            >
              {/* Row 1: Name + Toggle + Edit */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {/* Expand indicator */}
                  <svg
                    className={`w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-200 ${
                      isExpanded ? 'rotate-90' : ''
                    }`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  >
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                  <h4 className="text-sm font-medium text-[var(--text-primary)] truncate">{hook.name}</h4>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Toggle Switch */}
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggle(hook.id, !hook.enabled) }}
                    className={`w-8 h-4.5 rounded-full p-0.5 transition-colors relative ${
                      hook.enabled ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'
                    }`}
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${hook.enabled ? 'translate-x-3.5' : 'translate-x-0'}`}
                    />
                  </button>
                  {/* Edit Button */}
                  <button
                    onClick={(e) => { e.stopPropagation(); onEdit(hook) }}
                    className="p-1.5 rounded-lg hover:bg-[var(--surface-muted)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Row 2: Description */}
              <p className="text-xs text-[var(--text-muted)] mt-1.5 leading-relaxed">{hook.description || '暂无描述'}</p>

              {/* Row 3: Badges */}
              <div className="flex items-center gap-2 mt-2">
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                  hook.enabled
                    ? 'bg-[var(--success)]/10 text-[var(--success)]'
                    : 'bg-[var(--surface-muted)] text-[var(--text-muted)]'
                }`}>
                  {hook.enabled ? '启用' : '禁用'}
                </span>
                <span className="px-1.5 py-0.5 rounded text-[9px] bg-[var(--surface-muted)] text-[var(--text-muted)]">
                  {TYPE_LABELS[hook.config.type as HookType] || 'unknown'}
                </span>
                {isPlugin && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
                    插件: {hook.pluginName}
                  </span>
                )}
              </div>

              {/* Row 4: Event + Matcher */}
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[10px] text-[var(--brand-primary)]">{def?.name || hook.events[0]}</span>
                {hook.config.matcher && (
                  <span className="text-[9px] text-[var(--text-muted)] font-mono bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">
                    match: {hook.config.matcher}
                  </span>
                )}
              </div>
            </div>

            {/* Expanded Detail Section */}
            {isExpanded && (
              <div className="border-t border-[var(--border-muted)] mx-3">
                <div className="py-3 space-y-4">
                  {/* Config Details */}
                  <div className="space-y-3">
                    <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">配置详情</span>
                    {config.type === 'command' && config.command && (
                      <div className="bg-[var(--surface-muted)] rounded-lg p-3">
                        <span className="text-[10px] text-[var(--text-muted)]">命令</span>
                        <pre className="text-xs text-[var(--text-primary)] mt-1 font-mono whitespace-pre-wrap break-all">{config.command}</pre>
                      </div>
                    )}
                    {config.type === 'http' && config.url && (
                      <div className="bg-[var(--surface-muted)] rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 rounded text-[9px] bg-[var(--brand-primary)] text-white">{config.method || 'POST'}</span>
                          <span className="text-xs text-[var(--text-primary)] font-mono">{config.url}</span>
                        </div>
                        {config.body && (
                          <div>
                            <span className="text-[10px] text-[var(--text-muted)]">Body</span>
                            <pre className="text-xs text-[var(--text-secondary)] mt-1 font-mono whitespace-pre-wrap">{config.body}</pre>
                          </div>
                        )}
                      </div>
                    )}
                    {config.type === 'prompt' && config.prompt && (
                      <div className="bg-[var(--surface-muted)] rounded-lg p-3">
                        <span className="text-[10px] text-[var(--text-muted)]">提示词</span>
                        <pre className="text-xs text-[var(--text-primary)] mt-1 whitespace-pre-wrap">{config.prompt}</pre>
                      </div>
                    )}
                  </div>

                  {/* Meta info + Actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-[var(--border-muted)]">
                    <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
                      <span>来源: {hook.source}</span>
                      <span>更新于 {new Date(hook.updatedAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {!isPlugin && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDelete(hook.id) }}
                          className="px-2.5 py-1 rounded-lg text-[10px] text-red-500 hover:bg-red-50 transition-all"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}



// Hook Editor Component
function HookEditor({ hook, eventDefinitions, onSave, onCancel }: {
  hook: Hook | null
  eventDefinitions: HookEventDefinition[]
  onSave: (data: any) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(hook?.name || '')
  const [description, setDescription] = useState(hook?.description || '')
  const [selectedEvent, setSelectedEvent] = useState(hook?.events[0] || eventDefinitions[0]?.event || '')
  const [hookType, setHookType] = useState<HookType>((hook?.config as any)?.type || 'command')
  const [enabled, setEnabled] = useState(hook?.enabled ?? true)
  const [matcher, setMatcher] = useState((hook?.config as any)?.matcher || '')
  const [command, setCommand] = useState((hook?.config as any)?.command || '')
  const [url, setUrl] = useState((hook?.config as any)?.url || '')
  const [method, setMethod] = useState((hook?.config as any)?.method || 'POST')
  const [body, setBody] = useState((hook?.config as any)?.body || '')
  const [prompt, setPrompt] = useState((hook?.config as any)?.prompt || '')
  const [shell, setShell] = useState((hook?.config as any)?.shell || 'bash')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  // 初始加载时根据内容自动调整高度
  useEffect(() => {
    if (textareaRef.current) {
      autoResize(textareaRef.current)
    }
  }, [])

  const selectedDef = eventDefinitions.find(d => d.event === selectedEvent)

  const handleSubmit = () => {
    if (!name.trim() || !selectedEvent) return

    const config: HookConfig = { type: hookType } as any
    if (hookType === 'command') {
      config.command = command
      config.shell = shell as any
    } else if (hookType === 'http') {
      config.url = url
      config.method = method as any
      config.body = body
    } else if (hookType === 'prompt') {
      config.prompt = prompt
    }

    if (matcher.trim()) {
      config.matcher = matcher
    }

    onSave({
      name: name.trim(),
      description: description.trim(),
      events: [selectedEvent],
      config,
      enabled
    })
  }

  const handleRestore = async () => {
    if (!hook || hook.source !== 'plugin' || !hook.pluginName) return
    const defaults = await window.electronAPI?.hooks?.getPluginDefaults(hook.pluginName, hook.id)
    if (!defaults) return

    setName(defaults.name || '')
    setDescription(defaults.description || '')
    if (defaults.events?.length) setSelectedEvent(defaults.events[0])
    if (defaults.type) setHookType(defaults.type as HookType)
    setCommand(defaults.command || '')
    setShell(defaults.shell || 'bash')
    setUrl(defaults.url || '')
    setMethod(defaults.method || 'POST')
    setBody(defaults.body || '')
    setPrompt(defaults.prompt || '')
    setMatcher(defaults.matcher || '')
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-[var(--text-primary)]">{hook ? '编辑 Hook' : '创建 Hook'}</h3>
        <button onClick={onCancel} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          取消
        </button>
      </div>

      <div className="space-y-4">
        {/* Name */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">名称</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="如：安全审计通知"
            className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm focus:border-[var(--brand-primary)] outline-none transition-all"
          />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">描述</label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="简短描述这个 Hook 的作用"
            className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm focus:border-[var(--brand-primary)] outline-none transition-all"
          />
        </div>

        {/* Event Selection */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">触发事件</label>
          <select
            value={selectedEvent}
            onChange={e => setSelectedEvent(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm focus:border-[var(--brand-primary)] outline-none transition-all"
          >
            {eventDefinitions.map(def => (
              <option key={def.event} value={def.event}>
                {def.name} - {def.description.slice(0, 40)}...
              </option>
            ))}
          </select>
          {selectedDef && (
            <p className="text-[10px] text-[var(--text-muted)]">{selectedDef.description}</p>
          )}
        </div>

        {/* Hook Type */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">类型</label>
          <div className="flex gap-2">
            {(['command', 'http', 'prompt', 'agent'] as HookType[]).map(type => (
              <button
                key={type}
                onClick={() => setHookType(type)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  hookType === type
                    ? 'bg-[var(--brand-primary)] text-white shadow-sm'
                    : 'bg-[var(--surface-muted)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--brand-primary)]'
                }`}
              >
                {TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        </div>

        {/* Type-specific config */}
        {hookType === 'command' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">命令</label>
              <textarea
                ref={textareaRef}
                value={command}
                onChange={e => {
                  setCommand(e.target.value)
                  autoResize(e.target)
                }}
                placeholder={"如：echo 'Triggered'"}
                rows={1}
                className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm font-mono focus:border-[var(--brand-primary)] outline-none transition-all resize-none overflow-hidden"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">Shell</label>
              <div className="flex gap-2">
                {(['bash', 'powershell'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setShell(s)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      shell === s
                        ? 'bg-[var(--brand-primary)] text-white shadow-sm'
                        : 'bg-[var(--surface-muted)] border border-[var(--border)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {s === 'powershell' ? 'PowerShell' : IS_WIN ? 'CMD' : 'Bash'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {hookType === 'http' && (
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="w-24 space-y-1.5">
                <label className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Method</label>
                <select
                  value={method}
                  onChange={e => setMethod(e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs focus:border-[var(--brand-primary)] outline-none"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div className="flex-1 space-y-1.5">
                <label className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">URL</label>
                <input
                  type="text"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://api.example.com/webhook"
                  className="w-full px-3 py-1.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs font-mono focus:border-[var(--brand-primary)] outline-none"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Body (JSON)</label>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={3}
                placeholder='{"key": "value"}'
                className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs font-mono focus:border-[var(--brand-primary)] outline-none resize-none"
              />
            </div>
          </div>
        )}

        {hookType === 'prompt' && (
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">提示词内容</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={4}
              placeholder="输入提示词内容，可以使用 ${HCLAW_SESSION_ID} 等变量"
              className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm focus:border-[var(--brand-primary)] outline-none resize-none"
            />
          </div>
        )}

        {/* Matcher */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">匹配器 <span className="ml-1 text-[9px] font-normal normal-case text-[var(--text-muted)]">（可选，用于过滤特定工具或文件）</span></label>
          <input
            type="text"
            value={matcher}
            onChange={e => setMatcher(e.target.value)}
            placeholder="如：Read|Write 或 .*\.ts$"
            className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm font-mono focus:border-[var(--brand-primary)] outline-none transition-all"
          />
        </div>

        {/* Enabled Toggle */}
        <div className="flex items-center gap-3 pt-2">
          <Switch checked={enabled} onChange={setEnabled} />
          <span className="text-xs font-medium text-[var(--text-secondary)]">启用此 Hook</span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-4 border-t border-[var(--border-muted)]">
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !selectedEvent}
            className="px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-bold shadow-sm hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {hook ? '保存修改' : '创建 Hook'}
          </button>
          {hook?.source === 'plugin' && (
            <button
              onClick={handleRestore}
              className="px-4 py-2 rounded-lg bg-orange-50 border border-orange-200 text-orange-600 text-sm font-medium hover:bg-orange-100 transition-all"
            >
              还原
            </button>
          )}
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-elevated)] transition-all"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}