import {useEffect, useMemo, useRef, useState} from 'react'
import {motion} from 'framer-motion'
import type {LLMProvider, ProviderModel} from '../../stores/llmStore'
import {useLLMStore} from '../../stores/llmStore'
import type {ModelType} from '@shared/types'
import {isEncrypted} from '../../lib/crypto'
import {
  GOOGLE_BASE_URL,
  PROVIDER_PRESETS as MODEL_PRESETS,
  presetModelsFor,
  recognizeProvider,
  validateBaseUrl,
  type BaseUrlValidation,
  type ProviderPreset,
} from '@shared/modelPresets'

interface ProviderEditModalProps {
  mode: 'add' | 'edit'
  provider?: LLMProvider | null
  onClose: () => void
  onSave: (data: Omit<LLMProvider, 'id'> & { models?: ProviderModel[] }) => Promise<void>
}

/** 预设快捷卡片（官方 4 类型；与识别表 MODEL_PRESETS 独立，卡片固定展示这 4 个） */
const CARD_PRESETS: Array<{ id: LLMProvider['type']; name: string; baseUrl: string }> = [
  {id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1'},
  {id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com'},
  {id: 'google', name: 'Google', baseUrl: GOOGLE_BASE_URL},
  {id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434'},
]

export default function ProviderEditModal({mode, provider, onClose, onSave}: ProviderEditModalProps) {
  const {getDecryptedApiKey} = useLLMStore()
  const isEdit = mode === 'edit'

  // ─── 表单状态 ──────────────────────────────────────
  const [name, setName] = useState(provider?.name || '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '')
  // Base URL 校验结果（onBlur 触发，避免打字闪烁）
  const [baseUrlValidation, setBaseUrlValidation] = useState<BaseUrlValidation | null>(null)
  const recognizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiKeyTouched, setApiKeyTouched] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [providerType, setProviderType] = useState<LLMProvider['type']>(provider?.type || 'openai')
  const [authType, setAuthType] = useState<'api-key' | 'google-oauth2'>(provider?.authType || 'api-key')
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const [saving, setSaving] = useState(false)

  // OAuth2
  const [oauthTokens, setOauthTokens] = useState<{ accessToken: string; refreshToken: string; expiryDate: number } | null>(null)
  const [email, setEmail] = useState<string | undefined>(provider?.email)

  // 缓存特性
  const [useSystemArray, setUseSystemArray] = useState(
    provider?.features?.systemContentBlocks ?? true
  )

  // 模型列表
  const [models, setModels] = useState<ProviderModel[]>(provider?.models.map(m => ({...m})) || [])
  const [isLoggingIn, setIsLoggingIn] = useState(false)

  // 拉取结果面板
  const [fetchedResult, setFetchedResult] = useState<{id: string; modelType?: ModelType}[] | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetchSearch, setFetchSearch] = useState('')
  const [fetchTypeFilter, setFetchTypeFilter] = useState<'all' | ModelType>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 测试状态：key=模型 UUID，value=结果（不写入 ProviderModel，关窗即清空）
  const [testStates, setTestStates] = useState<Record<string, {status: 'testing' | 'ok' | 'fail'; error?: string; latencyMs?: number}>>({})
  const [batchTesting, setBatchTesting] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{done: number; total: number} | null>(null)
  const batchCancelRef = useRef(false)
  const testSnapshotRef = useRef<{
    type: LLMProvider['type']; baseUrl: string; apiKey: string; authType: 'api-key' | 'google-oauth2'
    accessToken?: string; refreshToken?: string; expiryDate?: number
  } | null>(null)

  // 模型校验
  const modelValidationError = useMemo<string | null>(() => {
    for (const m of models) {
      if (!m.name.trim()) return '部分模型名称未填写'
      if (models.filter(mm => mm.name.trim().toLowerCase() === m.name.trim().toLowerCase()).length > 1) return '存在重复的模型名称'
    }
    return null
  }, [models])

  // 添加模式：表单必填项校验
  const formValidationError = useMemo<string | null>(() => {
    if (isEdit) return null
    if (!name.trim()) return '服务商名称不能为空'
    if (providerType !== 'google' && !baseUrl.trim()) return 'API Base URL 不能为空'
    if (authType === 'api-key' && !apiKey.trim()) return 'API Key 不能为空'
    if (models.length === 0 || models.every(m => !m.name.trim())) return '请至少填写一个模型'
    return null
  }, [isEdit, name, providerType, baseUrl, authType, apiKey, models])

  const isEncryptedKey = useMemo(() => isEdit && isEncrypted(provider?.credentials?.apiKey || ''), [isEdit, provider?.credentials?.apiKey])
  const decryptionAbortRef = useRef(false)

  // 编辑模式：解密 API Key
  useEffect(() => {
    if (!isEdit || !provider) return
    decryptionAbortRef.current = false
    if (isEncryptedKey) {
      getDecryptedApiKey(provider.id).then((decrypted) => {
        if (!decryptionAbortRef.current && decrypted) setApiKey(decrypted)
      })
    } else {
      setApiKey(provider.credentials?.apiKey || '')
    }
    return () => { decryptionAbortRef.current = true }
  }, [isEdit, provider?.id, isEncryptedKey, getDecryptedApiKey])

  // 监听 Google 登录成功
  useEffect(() => {
    if (providerType !== 'google') return
    const handleGoogleSuccess = async (tokens: any) => {
      setIsLoggingIn(false)
      setOauthTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiryDate: tokens.expiryDate,
      })
      setAuthType('google-oauth2')
      setApiKey(tokens.accessToken)
      setApiKeyTouched(true)  // OAuth 认证成功视为主动修改了 credential
      setEmail(tokens.email)
    }
    const cleanup = window.electronAPI?.onGoogleAuthSuccess(handleGoogleSuccess)
    return () => cleanup?.()
  }, [providerType])

  // 按 ESC 关闭弹窗
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [onClose])

  // 卸载时清理识别防抖定时器
  useEffect(() => () => {
    if (recognizeDebounceRef.current) clearTimeout(recognizeDebounceRef.current)
    batchCancelRef.current = true // 弹窗关闭中止批量测试
  }, [])

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true)
    try { await window.electronAPI?.authGoogleLogin() } catch { setIsLoggingIn(false) }
  }

  /** 编辑模式解密失败 / 未填入的 key 返回 ''（供拉取/测试前置判断） */
  const getEffectiveApiKey = () => {
    if (isEdit && !apiKeyTouched && isEncryptedKey && !apiKey) return '' // 解密失败
    return apiKey
  }

  /** 切换类型：模型列表为空时填充该类型的预设模型（识别到的 preset 用其专属模型，否则用类型默认值） */
  const applyTypeChange = (preset: ProviderPreset | null, type: LLMProvider['type']) => {
    setModels(prev => {
      if (prev.length > 0) return prev
      return presetModelsFor(preset, type).map(name => ({id: crypto.randomUUID(), name, enabled: true}))
    })
  }

  /** Base URL onChange：识别服务商（仅添加模式 + name 为空时辅助填充；不覆盖已填内容） */
  const handleBaseUrlChange = (value: string) => {
    setTestStates({})
    setBaseUrl(value)
    if (isEdit) return
    if (recognizeDebounceRef.current) clearTimeout(recognizeDebounceRef.current)
    recognizeDebounceRef.current = setTimeout(() => {
      const preset = recognizeProvider(value)
      if (!preset) return
      setName(prev => (prev.trim() ? prev : preset.name))
      setProviderType(preset.type)
      applyTypeChange(preset, preset.type)
    }, 300)
  }

  /** Base URL onBlur：格式校验 + 已知服务商标准格式提示 */
  const handleBaseUrlBlur = () => {
    const preset = recognizeProvider(baseUrl)
    const validation = validateBaseUrl(providerType, baseUrl)
    if (preset?.expectedFormat) {
      setBaseUrlValidation({level: validation.level, message: `检测到 ${preset.name}，API 地址正确格式：${preset.expectedFormat}`})
    } else {
      setBaseUrlValidation(validation)
    }
  }

  /** 拉取前置校验：无 key 不可用 */
  const canFetch = useMemo(() => {
    if (providerType === 'ollama') return true
    if (providerType === 'google') {
      if (authType === 'google-oauth2') return !!oauthTokens?.accessToken || !!provider?.credentials?.accessToken
      return !!getEffectiveApiKey().trim()
    }
    return !!getEffectiveApiKey().trim()
  }, [providerType, authType, apiKey, apiKeyTouched, isEncryptedKey, isEdit, oauthTokens, provider?.credentials?.accessToken])

  const handleFetchModels = async () => {
    if (fetching) return
    setFetching(true)
    setFetchError(null)
    try {
      const result = await window.electronAPI?.providerFetchModels?.({
        type: providerType,
        baseUrl: providerType === 'google' ? GOOGLE_BASE_URL : baseUrl.trim() || undefined,
        apiKey: getEffectiveApiKey().trim() || undefined,
        authType,
        accessToken: oauthTokens?.accessToken || provider?.credentials?.accessToken,
        refreshToken: oauthTokens?.refreshToken || provider?.credentials?.refreshToken,
        expiryDate: oauthTokens?.expiryDate || provider?.credentials?.expiryDate,
      }) as
        | { success: true; data: {id: string; modelType?: ModelType}[]; oauthTokens?: {accessToken: string; refreshToken: string; expiryDate: number} }
        | { success: false; error: string }
        | undefined
      if (!result?.success) {
        setFetchError(result?.error || '拉取失败')
        return
      }
      if (result.oauthTokens) {
        setOauthTokens({accessToken: result.oauthTokens.accessToken, refreshToken: result.oauthTokens.refreshToken, expiryDate: result.oauthTokens.expiryDate})
        setApiKeyTouched(true)
      }
      setFetchedResult(result.data)
      // 默认勾选 text/multimodal 与未标注类型的模型
      setSelectedIds(new Set(result.data.filter(m => !m.modelType || m.modelType === 'text' || m.modelType === 'multimodal').map(m => m.id)))
      setFetchSearch('')
      setFetchTypeFilter('all')
    } finally {
      setFetching(false)
    }
  }

  /** 勾选项 → ProviderModel（生成 UUID id + 携带 modelType） */
  const selectedModels = () => {
    if (!fetchedResult) return []
    return fetchedResult
      .filter(m => selectedIds.has(m.id))
      .map(m => ({id: crypto.randomUUID(), name: m.id, modelType: m.modelType, enabled: true}))
  }

  const handleReplace = () => {
    if (!fetchedResult) return
    const picked = selectedModels()
    if (picked.length === 0) return
    if (models.length > 0 && !window.confirm(`将清空现有 ${models.length} 个模型并用勾选项替换（替换后请检查模型方案中的角色引用）`)) return
    setModels(picked)
    setFetchedResult(null)
    setSelectedIds(new Set())
  }

  const handleMerge = () => {
    if (!fetchedResult) return
    const picked = selectedModels()
    if (picked.length === 0) return
    const existing = new Set(models.map(m => m.name.trim().toLowerCase()))
    const added = picked.filter(m => !existing.has(m.name.toLowerCase()))
    setModels([...models, ...added])
    setFetchedResult(null)
    setSelectedIds(new Set())
  }

  /** 单行测试是否可用（与 canFetch 同规则） */
  const canTest = canFetch

  /** 记录测试参数快照（点击瞬间） */
  const snapshotTestParams = () => {
    testSnapshotRef.current = {
      type: providerType,
      baseUrl: providerType === 'google' ? GOOGLE_BASE_URL : baseUrl.trim(),
      apiKey: getEffectiveApiKey().trim(),
      authType,
      accessToken: oauthTokens?.accessToken || provider?.credentials?.accessToken,
      refreshToken: oauthTokens?.refreshToken || provider?.credentials?.refreshToken,
      expiryDate: oauthTokens?.expiryDate || provider?.credentials?.expiryDate,
    }
  }

  const runSingleTest = async (modelId: string, modelName: string): Promise<void> => {
    const snap = testSnapshotRef.current
    if (!snap) return
    const result = await window.electronAPI?.providerTestModel?.({
      type: snap.type,
      baseUrl: snap.baseUrl || undefined,
      apiKey: snap.apiKey || undefined,
      authType: snap.authType,
      accessToken: snap.accessToken,
      refreshToken: snap.refreshToken,
      expiryDate: snap.expiryDate,
      model: modelName.trim(),
      features: providerType === 'anthropic' ? {systemContentBlocks: useSystemArray} : undefined,
    })
    if (result?.success) {
      if (result.oauthTokens) {
        setOauthTokens({accessToken: result.oauthTokens.accessToken, refreshToken: result.oauthTokens.refreshToken, expiryDate: result.oauthTokens.expiryDate})
        setApiKeyTouched(true)
      }
      setTestStates(prev => ({...prev, [modelId]: {status: 'ok', latencyMs: result.latencyMs}}))
    } else {
      setTestStates(prev => ({...prev, [modelId]: {status: 'fail', error: result?.error || '测试失败'}}))
    }
  }

  const handleTestModel = async (modelId: string, modelName: string) => {
    if (batchTesting) return
    if (!modelName.trim()) return
    setTestStates(prev => ({...prev, [modelId]: {status: 'testing'}}))
    snapshotTestParams()
    await runSingleTest(modelId, modelName)
  }

  const handleTestAll = async () => {
    if (batchTesting) return
    const targets = models.filter(m => m.name.trim())
    if (targets.length === 0) return
    setBatchTesting(true)
    setBatchProgress({done: 0, total: targets.length})
    batchCancelRef.current = false
    snapshotTestParams()
    for (let i = 0; i < targets.length; i++) {
      if (batchCancelRef.current) break
      const t = targets[i]
      if (!models.some(m => m.id === t.id)) continue // 测试中已删除的行跳过
      setTestStates(prev => ({...prev, [t.id]: {status: 'testing'}}))
      await runSingleTest(t.id, t.name)
      setBatchProgress({done: i + 1, total: targets.length})
    }
    setBatchTesting(false)
    setBatchProgress(null)
  }

  const filteredFetched = useMemo(() => {
    if (!fetchedResult) return []
    const q = fetchSearch.trim().toLowerCase()
    return fetchedResult.filter(m =>
      (!fetchTypeFilter || fetchTypeFilter === 'all' || m.modelType === fetchTypeFilter) &&
      (!q || m.id.toLowerCase().includes(q))
    )
  }, [fetchedResult, fetchSearch, fetchTypeFilter])

  // 认证状态
  const authStatus = useMemo(() => {
    if (authType !== 'google-oauth2') return 'normal'
    const expiryDate = oauthTokens?.expiryDate || provider?.credentials?.expiryDate
    if (!expiryDate) return 'missing'
    if (Date.now() > expiryDate) return 'expired'
    return 'valid'
  }, [authType, oauthTokens, provider?.credentials?.expiryDate])

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const data: any = {
        name: name.trim(),
        type: providerType,
        authType: authType,
        email: email,
        baseUrl: providerType === 'google' ? GOOGLE_BASE_URL : (baseUrl.trim() || undefined),
        features: providerType === 'anthropic' ? { systemContentBlocks: useSystemArray } : undefined,
        credentials: authType === 'google-oauth2' && oauthTokens ? {
          accessToken: oauthTokens.accessToken,
          refreshToken: oauthTokens.refreshToken,
          expiryDate: oauthTokens.expiryDate,
        } : {
          apiKey: (apiKeyTouched || !isEdit) ? (apiKey.trim() || undefined) : undefined,
        },
        enabled,
        models,
      }
      // 编辑模式下如果没有修改 apiKey，不覆盖原有的加密值
      if (isEdit && !apiKeyTouched) {
        delete data.credentials
      }
      await onSave(data)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* Backdrop — 不绑定关闭事件，防止意外丢失表单数据 */}
      <motion.div
        initial={{opacity: 0}}
        animate={{opacity: 1}}
        exit={{opacity: 0}}
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[99998]"
      />
      {/* Modal */}
      <motion.div
        initial={{scale: 0.95, opacity: 0}}
        animate={{scale: 1, opacity: 1}}
        exit={{scale: 0.95, opacity: 0}}
        transition={{duration: 0.15, ease: 'easeOut'}}
        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none z-[99999]"
      >
        <div
          className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-white rounded-xl shadow-elevated border border-gray-200 pointer-events-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 bg-white z-10 px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">{isEdit ? '编辑服务商' : '添加服务商'}</h3>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="px-5 py-4 space-y-4">
            {/* 预设快捷选择 */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">API类型</label>
              <div className="grid grid-cols-4 gap-1.5">
                {CARD_PRESETS.map((p) => (
                  <button key={p.id} onClick={() => {
                    setProviderType(p.id)
                    if (p.id === 'google') {
                      // 切到 Google 保持当前 authType
                    } else {
                      setAuthType('api-key')
                    }
                    if (!isEdit) {
                      setName(p.name)
                      setBaseUrl(p.baseUrl)
                    }
                    applyTypeChange(null, p.id)
                  }}
                    className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                      providerType === p.id ? 'bg-brand-50 border-brand-200 text-brand-600' : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    }`}
                  >{p.name}</button>
                ))}
              </div>
            </div>

            {/* 服务商名称 */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">服务商名称 <span className="text-red-400">*</span></label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="例如：OpenAI"
                className={`w-full px-2.5 py-1.5 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${
                  !isEdit && !name.trim() ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                }`} />
              {!isEdit && !name.trim() && <div className="text-[10px] text-red-400 mt-0.5">服务商名称不能为空</div>}
            </div>

            {/* Base URL — Google 使用 SDK 固定端点，无需用户配置 */}
            {providerType !== 'google' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">API Base URL <span className="text-red-400">*</span></label>
                <input type="text" value={baseUrl} onChange={(e) => handleBaseUrlChange(e.target.value)} onBlur={handleBaseUrlBlur}
                  placeholder="https://api.openai.com/v1"
                  className={`w-full px-2.5 py-1.5 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${
                    !isEdit && !baseUrl.trim() ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                  }`} />
                {!isEdit && !baseUrl.trim() && <div className="text-[10px] text-red-400 mt-0.5">API Base URL 不能为空</div>}
                {/* Base URL 格式校验提示（onBlur 触发，只提示不修改） */}
                {baseUrlValidation?.level === 'warn' && (
                  <div className="mt-1 text-[10px] text-amber-500 flex items-start gap-1">
                    <svg className="w-3 h-3 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span>{baseUrlValidation.message}</span>
                  </div>
                )}
                {baseUrlValidation?.level === 'error' && (
                  <div className="mt-1 text-[10px] text-red-400 flex items-start gap-1">
                    <svg className="w-3 h-3 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span>{baseUrlValidation.message}</span>
                  </div>
                )}
              </div>
            )}

            {/* API Key / OAuth */}
            {providerType === 'google' ? (
              <div className="p-3 rounded-md bg-gray-50 border border-gray-100 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-500">认证方式</label>
                  <select value={authType} onChange={(e) => setAuthType(e.target.value as any)}
                    className="text-[10px] bg-white border border-gray-200 rounded px-1 py-0.5 focus:outline-none">
                    <option value="api-key">API Key</option>
                    <option value="google-oauth2">Google 登录</option>
                  </select>
                </div>
                {authType === 'google-oauth2' ? (
                  <div className="space-y-2">
                    {authStatus === 'valid' ? (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-green-600 font-medium flex items-center gap-1">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                          已授权: {email || 'Google 账号'}
                        </span>
                        <button onClick={handleGoogleLogin} className="text-[10px] text-brand-500 hover:underline">切换账号</button>
                      </div>
                    ) : authStatus === 'expired' ? (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-orange-500 font-medium flex items-center gap-1">
                          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                          授权已过期
                        </span>
                        <button onClick={handleGoogleLogin} className="text-[10px] text-brand-500 font-medium hover:underline">立即刷新</button>
                      </div>
                    ) : (
                      <button onClick={handleGoogleLogin} disabled={isLoggingIn}
                        className="w-full py-1.5 bg-white border border-gray-200 rounded text-[11px] flex items-center justify-center gap-1.5 hover:bg-gray-50 transition-colors disabled:opacity-50">
                        {isLoggingIn ? '正在授权...' : '使用 Google 账号登录'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">API Key <span className="text-red-400">*</span></label>
                    <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true); setTestStates({}) }}
                      placeholder={isEncryptedKey ? '已加密' : 'sk-...'}
                      className={`w-full px-2.5 py-1.5 text-xs border rounded-md text-gray-700 placeholder-gray-300 focus:outline-none ${
                        !isEdit && !apiKey.trim() ? 'border-red-300 focus:border-red-400 bg-red-50' : 'border-gray-200 focus:border-brand-300 bg-white'
                      }`} />
                    {!isEdit && !apiKey.trim() && <div className="text-[10px] text-red-400 mt-0.5">API Key 不能为空</div>}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">API Key <span className="text-red-400">*</span></label>
                <div className="relative">
                  <input type={showApiKey ? 'text' : 'password'} value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true); setTestStates({}) }}
                    placeholder={isEncryptedKey ? '已加密' : 'sk-...'}
                    className={`w-full px-2.5 py-1.5 pr-8 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${
                      !isEdit && !apiKey.trim() ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                    }`} />
                  <button type="button" onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600">
                    {showApiKey ? (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* 启用开关 */}
            <label className="flex items-center gap-2 text-xs font-medium text-gray-500">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-gray-300 text-brand-500 focus:ring-brand-300" />
              启用此服务商
            </label>

            {/* System 缓存开关 — 仅 Anthropic 类型 */}
            {providerType === 'anthropic' && (
              <label className="flex items-center gap-2 text-xs font-medium text-gray-500">
                <input type="checkbox" checked={useSystemArray}
                  onChange={(e) => setUseSystemArray(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-brand-500 focus:ring-brand-300" />
                <div className="flex flex-col">
                  <span>启用 System Prompt 缓存</span>
                  <span className="text-[10px] text-gray-400">
                    将 system 以内容块数组发送并设置 cache_control，降低延迟与成本
                  </span>
                </div>
              </label>
            )}

            {/* 模型管理 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-gray-500">模型列表</label>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-400">{models.length} 个模型</span>
                  {batchTesting ? (
                    <button onClick={() => { batchCancelRef.current = true }}
                      className="flex items-center gap-1 text-[10px] font-medium text-orange-500 hover:text-orange-600 transition-colors">
                      {batchProgress ? `测试中 ${batchProgress.done}/${batchProgress.total} · 取消` : '测试中...'}
                    </button>
                  ) : (
                    <button onClick={handleTestAll} disabled={models.filter(m => m.name.trim()).length === 0 || !canTest}
                      title={!canTest ? (isEdit && isEncryptedKey && !apiKeyTouched && !apiKey ? '无法解密 API Key，请重新填写' : '请先填写 API Key') : '测试全部模型'}
                      className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      测试全部
                    </button>
                  )}
                  <button onClick={handleFetchModels} disabled={fetching || !canFetch}
                    title={!canFetch ? (providerType === 'google' && authType === 'google-oauth2' ? 'Google 未授权，请先完成登录' : isEdit && isEncryptedKey && !apiKeyTouched && !apiKey ? '无法解密 API Key，请重新填写' : '请先填写 API Key') : '自动获取模型列表'}
                    className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    {fetching
                      ? <span className="w-3 h-3 border-2 border-brand-300 border-t-transparent rounded-full animate-spin" />
                      : <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6"/></svg>}
                    自动获取
                  </button>
                </div>
              </div>

              {/* 拉取结果面板（就地展开，不嵌套模态） */}
              {fetchedResult && (
                <div className="mb-2 border border-brand-200 bg-brand-50/50 rounded-md p-2">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] font-medium text-gray-600 shrink-0">已获取 {fetchedResult.length} 个模型</span>
                    <input value={fetchSearch} onChange={(e) => setFetchSearch(e.target.value)} placeholder="搜索模型..."
                      className="flex-1 min-w-0 px-2 py-1 text-[10px] border border-gray-200 rounded-md focus:outline-none focus:border-brand-300" />
                    <select value={fetchTypeFilter} onChange={(e) => setFetchTypeFilter(e.target.value as any)}
                      className="text-[10px] border border-gray-200 rounded px-1 py-1 bg-white focus:outline-none">
                      <option value="all">全部类型</option>
                      <option value="text">文本</option>
                      <option value="image">图像</option>
                      <option value="voice">音频</option>
                      <option value="video">视频</option>
                      <option value="music">音乐</option>
                      <option value="embedding">向量</option>
                    </select>
                    <button onClick={() => setSelectedIds(new Set(fetchedResult.map(m => m.id)))} className="text-[10px] text-brand-500 hover:underline shrink-0">全选</button>
                    <button onClick={() => setSelectedIds(new Set())} className="text-[10px] text-gray-400 hover:underline shrink-0">清空</button>
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-0.5 mb-1.5">
                    {filteredFetched.map(m => (
                      <label key={m.id} className="flex items-center gap-1.5 text-[10px] font-mono text-gray-600 cursor-pointer">
                        <input type="checkbox" checked={selectedIds.has(m.id)}
                          onChange={(e) => setSelectedIds(prev => { const s = new Set(prev); if (e.target.checked) s.add(m.id); else s.delete(m.id); return s })}
                          className="w-3 h-3 rounded border-gray-300 text-brand-500" />
                        <span className="flex-1 truncate">{m.id}</span>
                        <span className="text-[9px] px-1 rounded bg-gray-100 text-gray-400 shrink-0">{m.modelType || 'text'}</span>
                      </label>
                    ))}
                    {filteredFetched.length === 0 && <div className="text-[10px] text-gray-400 py-1 text-center">无匹配模型</div>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={handleReplace} className="px-2 py-1 text-[10px] bg-brand-500 text-white rounded-md hover:bg-brand-600">替换</button>
                    <button onClick={handleMerge} className="px-2 py-1 text-[10px] border border-brand-200 text-brand-600 rounded-md hover:bg-brand-50/50">合并</button>
                    <button onClick={() => { setFetchedResult(null); setSelectedIds(new Set()) }} className="px-2 py-1 text-[10px] text-gray-400 hover:text-gray-600">取消</button>
                    <span className="text-[9px] text-gray-400 ml-auto">已选 {selectedIds.size} 个</span>
                  </div>
                </div>
              )}

              {fetchError && (
                <div className="mb-2 text-[10px] text-red-400">{fetchError}</div>
              )}

              {/* Model rows */}
              <div className="space-y-1.5 mb-2">
                {models.map((model, i) => {
                  const isEmpty = !model.name.trim()
                  const isDuplicate = !isEmpty && models.some((m, j) => j !== i && m.name.trim().toLowerCase() === model.name.trim().toLowerCase())
                  return (
                    <div key={model.id}>
                      <div className="flex items-center gap-1 group">
                        <label className="flex items-center shrink-0">
                          <input type="checkbox" checked={model.enabled}
                            onChange={(e) => setModels(models.map(m => m.id === model.id ? {...m, enabled: e.target.checked} : m))}
                            className="w-3 h-3 rounded border-gray-300 text-brand-500" />
                        </label>
                        <input type="text" value={model.name} placeholder="模型名称"
                          onChange={(e) => {
                            setModels(models.map(m => m.id === model.id ? {...m, name: e.target.value} : m))
                            // 模型名称变更后清空该模型测试结果，避免旧结果匹配新名称造成误导
                            setTestStates(prev => { const next = {...prev}; delete next[model.id]; return next })
                          }}
                          className={`flex-1 min-w-0 px-2 py-1 text-[11px] font-mono bg-white border rounded text-gray-700 focus:outline-none placeholder-gray-400 ${
                            isEmpty || isDuplicate ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                          }`} />
                        {/* 测试状态位（⚡ 按钮 / spinner / ✔ / ✖） */}
                        {testStates[model.id]?.status === 'testing' ? (
                          <span className="shrink-0 w-3 h-3 border-2 border-brand-300 border-t-transparent rounded-full animate-spin" />
                        ) : testStates[model.id]?.status === 'ok' ? (
                          <span className="shrink-0 text-green-500 text-[11px]" title={`${testStates[model.id].latencyMs}ms`} data-tooltip={`${testStates[model.id].latencyMs}ms`}>✔</span>
                        ) : testStates[model.id]?.status === 'fail' ? (
                          <span className="shrink-0 text-red-500 text-[11px] cursor-help" title={testStates[model.id].error} data-tooltip={testStates[model.id].error}>✖</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleTestModel(model.id, model.name) }}
                            disabled={batchTesting || !canTest || !model.name.trim()}
                            title={!model.name.trim() ? '请先填写模型名称' : !canTest ? (isEdit && isEncryptedKey && !apiKeyTouched && !apiKey ? '无法解密 API Key，请重新填写' : '请先填写 API Key') : '测试此模型'}
                            className="shrink-0 p-1 text-gray-300 hover:text-brand-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                          </button>
                        )}
                        <button onClick={() => setModels(models.filter(m => m.id !== model.id))}
                          className="shrink-0 p-1 text-gray-300 hover:text-red-400 transition-colors"
                          title="删除">
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12"/>
                          </svg>
                        </button>
                      </div>
                      {isEmpty && <div className="text-[10px] text-red-400 mt-0.5 pl-5">模型名称不能为空</div>}
                      {isDuplicate && <div className="text-[10px] text-red-400 mt-0.5 pl-5">模型名称已存在</div>}
                    </div>
                  )
                })}
              </div>

              {/* "+" button to add model */}
              <button onClick={() => setModels([...models, {
                id: crypto.randomUUID(), name: '', enabled: true
              }])}
                className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 transition-colors">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
                添加模型
              </button>
            </div>
          </div>

          {/* Footer */}
          <div className="sticky bottom-0 bg-[var(--surface)] border-t border-gray-200 px-5 py-3 flex items-center justify-between">
            <div className="text-[11px] text-red-400">{formValidationError || modelValidationError || ''}</div>
            <div className="flex items-center gap-2">
              <button onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors">
                取消
              </button>
              <button onClick={handleSave} disabled={saving || !name.trim() || !!modelValidationError || !!formValidationError}
                className="px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
                {saving && <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                {isEdit ? '保存' : '添加'}
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  )
}
