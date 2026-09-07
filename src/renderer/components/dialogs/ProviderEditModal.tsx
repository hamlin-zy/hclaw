import {useEffect, useMemo, useRef, useState} from 'react'
import {motion} from 'framer-motion'
import {fade, scaleFade} from '../../lib/motionPresets'
import type {LLMProvider, ProviderModel} from '../../stores/llmStore'
import type {ProviderCustomHeader} from '@shared/types'
import {useLLMStore} from '../../stores/llmStore'
import type {ModelType} from '@shared/types'
import {isEncrypted} from '../../lib/crypto'
import {confirm} from '../ConfirmDialog'
import {
  GOOGLE_BASE_URL,
  presetModelsFor,
  recognizeProvider,
  validateBaseUrl,
  type BaseUrlValidation,
  type ProviderPreset,
} from '@shared/modelPresets'
import ModelTable from './providerEdit/ModelTable'

/** 自定义请求头变量选项与示例值 */
const HEADER_VARIABLES: Array<{value: ProviderCustomHeader['variable'] | ''; label: string; sample?: string}> = [
  {value: '', label: '无'},
  {value: 'system.version', label: '系统版本', sample: '0.2.87'},
  {value: 'session.id', label: '会话ID', sample: 'a3f2c1d8-4e5b'},
]

/** 常用请求头名建议（datalist 提示，不限制输入） */
const HEADER_NAME_SUGGESTIONS = ['User-Agent', 'X-Request-ID', 'X-Title', 'HTTP-Referer', 'x-opencode-session', 'X-Custom-Auth']
import ThemedSelect from '../ThemedSelect'
import ThemedCombobox from '../ThemedCombobox'
import {useSettingsStore} from '../../stores/settingsStore'
import {ModelDetailModal} from './providerEdit/ModelDetailModal'

interface ProviderEditModalProps {
  mode: 'add' | 'edit'
  provider?: LLMProvider | null
  onClose: () => void
  onSave: (data: Omit<LLMProvider, 'id'> & { models?: ProviderModel[] }) => Promise<void>
}

/** 预设快捷卡片（官方 4 类型；与识别表 PROVIDER_PRESETS 独立，卡片固定展示这 4 个） */
const CARD_PRESETS: Array<{ id: LLMProvider['type']; name: string; baseUrl: string }> = [
  {id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1'},
  {id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com'},
  {id: 'google', name: 'Google', baseUrl: GOOGLE_BASE_URL},
  {id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434'},
]

export default function ProviderEditModal({mode, provider, onClose, onSave}: ProviderEditModalProps) {
  const {getDecryptedApiKey, providers} = useLLMStore()
  // 系统设置模型默认值（详情弹窗 placeholder 来源，照 settingsStore 现有订阅方式）
  const settingsModel = useSettingsStore(s => s.settings.model)
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
  const [apiStyle, setApiStyle] = useState<'chat' | 'responses'>(provider?.apiStyle || 'chat')
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const [saving, setSaving] = useState(false)

  // 自定义请求头（编辑模式用已有数据初始化，新增模式为空数组）
  const [customHeaders, setCustomHeaders] = useState<ProviderCustomHeader[]>(
    (provider?.customHeaders || []).map(h => ({...h}))
  )
  // 二级弹窗草稿：打开时深拷贝，行内编辑只改 draft，「确定」写回 customHeaders
  const [showHeadersModal, setShowHeadersModal] = useState(false)
  const [headersDraft, setHeadersDraft] = useState<ProviderCustomHeader[]>([])

  const openHeadersModal = () => {
    setHeadersDraft(customHeaders.map(h => ({...h})))
    setShowHeadersModal(true)
  }

  /** 行是否无效：headerName 已填但固定前缀与系统变量同时为空（解析结果为空头，无意义） */
  const isHeaderRowInvalid = (h: ProviderCustomHeader) =>
    !!h.headerName.trim() && !h.prefix?.trim() && !h.variable

  /** 「确定」：校验通过后过滤掉 headerName 为空的行写回主表单；存在无效行时阻止并提示 */
  const confirmHeadersModal = () => {
    if (headersDraft.some(isHeaderRowInvalid)) return
    setCustomHeaders(headersDraft.filter(h => h.headerName.trim()).map(h => ({...h, headerName: h.headerName.trim()})))
    setShowHeadersModal(false)
  }

  const updateHeaderDraft = (id: string, patch: Partial<ProviderCustomHeader>) => {
    setHeadersDraft(prev => prev.map(h => h.id === id ? {...h, ...patch} : h))
  }

  // OAuth2
  const [oauthTokens, setOauthTokens] = useState<{ accessToken: string; refreshToken: string; expiryDate: number } | null>(null)
  const [email, setEmail] = useState<string | undefined>(provider?.email)
  const [oauthError, setOauthError] = useState<string | null>(null)

  // 缓存特性
  const [useSystemArray, setUseSystemArray] = useState(
    provider?.features?.systemContentBlocks ?? true
  )

  // 模型列表
  const [models, setModels] = useState<ProviderModel[]>(provider?.models.map(m => ({...m})) || [])
  // models 的最新引用镜像：全表填充循环耗时数秒，期间用户可能删行/改名/编辑价格，
  // 闭包里的 models 快照已过期；行读取与空缺判断一律走 ref，杜绝 stale 写入/误报
  const modelsRef = useRef(models)
  useEffect(() => { modelsRef.current = models }, [models])
  // 填充提示（工具栏轻量提示，含未匹配红字）：单行填充由详情弹窗触发
  const [fillNotice, setFillNotice] = useState<{kind: 'ok' | 'error'; text: string} | null>(null)
  // 汇率（CNY/USD，详情弹窗折算展示用）：加载前用恒等 rate=1 避免错汇率组合；
  // exchangeRateGet 成功后一起切换（主进程已兜底 7.2，date null = 未同步）
  const [rate, setRate] = useState(1)
  // 模型详情弹窗（Task 7 接入渲染）：当前打开详情的模型 id，null = 关闭
  const [detailModelId, setDetailModelId] = useState<string | null>(null)
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

  // 服务商名称唯一校验（新增/编辑都生效；与 DB UNIQUE 约束同口径：trim + 大小写不敏感，排除自身）
  const nameValidationError = useMemo<string | null>(() => {
    if (!name.trim()) return null // 空名由下方必填校验提示
    const dup = providers.some(p => p.id !== provider?.id && p.name.trim().toLowerCase() === name.trim().toLowerCase())
    return dup ? '服务商名称已存在' : null
  }, [providers, provider?.id, name])

  // 表单必填项校验（添加/编辑通用）
  const formValidationError = useMemo<string | null>(() => {
    if (!name.trim()) return '服务商名称不能为空'
    if (providerType !== 'google' && !baseUrl.trim()) return 'API Base URL 不能为空'
    if (authType === 'api-key' && !apiKey.trim()) return 'API Key 不能为空'
    if (models.length === 0 || models.every(m => !m.name.trim())) return '请至少填写一个模型'
    return null
  }, [name, providerType, baseUrl, authType, apiKey, models])

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
      setOauthError(null)
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
    // 监听 Google 登录失败（主进程 token 交换/用户信息获取失败时通知，避免静默卡死）
    const handleGoogleError = (info: {error: string}) => {
      setIsLoggingIn(false)
      setOauthError(info.error || 'Google 授权失败，请重试')
    }
    const cleanup = window.electronAPI?.onGoogleAuthSuccess(handleGoogleSuccess)
    const cleanupError = window.electronAPI?.onGoogleAuthError(handleGoogleError)
    return () => {
      cleanup?.()
      cleanupError?.()
    }
  }, [providerType])

  // 按 ESC 关闭弹窗
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [onClose])

  // 卸载时清理识别防抖定时器（§三 B5：弹窗关闭不留残留状态）
  useEffect(() => () => {
    if (recognizeDebounceRef.current) clearTimeout(recognizeDebounceRef.current)
    batchCancelRef.current = true // 弹窗关闭中止批量测试
  }, [])

  // 挂载时获取参考汇率（§三 B5）：主进程已兜底 7.2；date null = 未同步
  useEffect(() => {
    let cancelled = false
    window.electronAPI?.exchangeRateGet?.()
      .then((res) => {
        if (cancelled || !res || !Number.isFinite(res.rate) || res.rate <= 0) return
        setRate(res.rate)
      })
      .catch(() => { /* 拉取失败保持中性恒等（USD, rate=1） */ })
    return () => { cancelled = true }
  }, [])

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true)
    setOauthError(null)
    try {
      const result = await window.electronAPI?.authGoogleLogin()
      // 主进程可能立即返回失败（如 client_id 未配置）
      if (result && !result.success) {
        setIsLoggingIn(false)
        setOauthError(result.error || 'Google 授权失败，请重试')
      }
    } catch {
      setIsLoggingIn(false)
      setOauthError('Google 授权启动失败')
    }
  }

  /** 编辑模式解密失败 / 未填入的 key 返回 ''（供拉取/测试前置判断） */
  const getEffectiveApiKey = () => {
    if (isEdit && !apiKeyTouched && isEncryptedKey && !apiKey) return '' // 解密失败
    return apiKey
  }

  /** 切换类型：模型列表为空时填充该类型的预设模型（识别到的 preset 用其专属模型，否则用类型默认值）；
   *  anthropic 不做预设填充（模型命名因中转/渠道差异大，预设列表易误导） */
  const applyTypeChange = (preset: ProviderPreset | null, type: LLMProvider['type']) => {
    setModels(prev => {
      if (prev.length > 0 || type === 'anthropic') return prev
      return presetModelsFor(preset, type).map(name => ({id: crypto.randomUUID(), name, enabled: true}))
    })
  }

  // ─── 单行填充（详情弹窗「填充本模型」，设计 §三 B4/B5）──────────────────────
  // 仅回填空缺价格列（已有价格一律不覆盖）；回填的是 USD/token 原始值，直接落 m.pricing
  // （不经过货币折算）；命中元数据时按 inputModalities 更新 modelType。

  /**
   * 回填单模型：按名称查 OpenRouter 元数据，填充该行空缺价格 + 更新 modelType，
   * 同步进 models。返回回填后的模型；未匹配 / 行不存在 → null（内部提示）。
   */
  const fillSingleRow = async (modelName: string): Promise<ProviderModel | null> => {
    const trimmed = modelName.trim()
    if (!trimmed) return null
    const r = await window.electronAPI?.modelMetaLookup?.(trimmed)
    if (!r?.matchedKey) {
      setFillNotice({kind: 'error', text: `「${trimmed}」未匹配到 OpenRouter 元数据`})
      return null
    }
    const m0 = modelsRef.current.find(m => m.name.trim() === trimmed)
    if (!m0) return null
    const multimodal = !!r.inputModalities?.length && r.inputModalities.some(x => x !== 'text')
    const positiveOrUndef = (v?: number) => (v ?? 0) > 0 ? v : undefined
    const next: ProviderModel = {
      ...m0,
      pricing: {
        input: m0.pricing?.input ?? positiveOrUndef(r.inputPrice),
        output: m0.pricing?.output ?? positiveOrUndef(r.outputPrice),
        cacheRead: m0.pricing?.cacheRead ?? positiveOrUndef(r.cacheReadPrice),
        cacheWrite: m0.pricing?.cacheWrite ?? r.cacheWritePrice,
      },
      modelType: multimodal ? 'multimodal' : m0.modelType ?? 'text',
    }
    setModels(prev => prev.map(m => m.id !== m0.id ? m : next))
    return next
  }

  /** 拉取采纳后：按 OpenRouter 元数据自动填充类型字段（仅类型；价格仍由用户手动维护）。
   *  规则：命中且输入模态含非 text → multimodal；命名推断出的特殊类型（video/image/...）不覆盖。 */
  const enrichTypesFromMeta = async (list: ProviderModel[]) => {
    let updated = 0
    for (const m of list) {
      const name = m.name.trim()
      if (!name) continue
      try {
        const r = await window.electronAPI?.modelMetaLookup?.(name)
        if (!r?.matchedKey) continue
        const multimodal = !!r.inputModalities?.length && r.inputModalities.some(x => x !== 'text')
        if (!multimodal) continue
        setModels(prev => prev.map(x => x.id === m.id && (x.modelType ?? 'text') === 'text' ? {...x, modelType: 'multimodal'} : x))
        updated++
      } catch { /* 单行查询失败跳过，不中断整体 */ }
    }
    if (updated > 0) setFillNotice({kind: 'ok', text: `已按 OpenRouter 元数据更新 ${updated} 行类型`})
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

  /** 拉取/测试不可用的提示文案（与 canFetch 判断对应） */
  const credentialBlockReason = useMemo(() => {
    if (providerType === 'google' && authType === 'google-oauth2') return 'Google 未授权，请先完成登录'
    if (isEdit && isEncryptedKey && !apiKeyTouched && !apiKey) return '无法解密 API Key，请重新填写'
    return '请先填写 API Key'
  }, [providerType, authType, isEdit, isEncryptedKey, apiKeyTouched, apiKey])

  /** 服务商返回刷新后的 oauth tokens 时同步到表单 */
  const applyOAuthTokens = (tokens: {accessToken: string; refreshToken: string; expiryDate: number}) => {
    setOauthTokens(tokens)
    setApiKeyTouched(true)
  }

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
      if (result.oauthTokens) applyOAuthTokens(result.oauthTokens)
      setFetchedResult(result.data)
      // B6：默认不勾选，由用户手动全选/逐项勾选
      setSelectedIds(new Set())
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

  const handleReplace = async () => {
    if (!fetchedResult) return
    const picked = selectedModels()
    if (picked.length === 0) return
    if (models.length > 0 && !(await confirm({title: '替换模型列表', message: `将清空现有 ${models.length} 个模型并用勾选项替换（替换后请检查模型方案中的角色引用）`, confirmVariant: 'warning'}))) return
    setModels(picked)
    setFetchedResult(null)
    setSelectedIds(new Set())
    void enrichTypesFromMeta(picked)
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
    void enrichTypesFromMeta(added)
  }

  /** 单行测试是否可用（与拉取同规则） */
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

  const runSingleTest = async (modelId: string, modelName: string, temperature?: number): Promise<void> => {
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
      temperature,
      features: providerType === 'anthropic' ? {systemContentBlocks: useSystemArray} : undefined,
    })
    if (result?.success) {
      if (result.oauthTokens) applyOAuthTokens(result.oauthTokens)
      setTestStates(prev => ({...prev, [modelId]: {status: 'ok', latencyMs: result.latencyMs}}))
    } else {
      setTestStates(prev => ({...prev, [modelId]: {status: 'fail', error: result?.error || '测试失败'}}))
    }
  }

  const handleTestModel = async (modelId: string, modelName: string, temperature?: number) => {
    if (batchTesting) return
    if (!modelName.trim()) return
    setTestStates(prev => ({...prev, [modelId]: {status: 'testing'}}))
    snapshotTestParams()
    await runSingleTest(modelId, modelName, temperature)
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
      await runSingleTest(t.id, t.name, t.temperature ?? undefined)
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
      // 从预设获取 supportsExplicitCaching（用于显式提示词缓存）
      const preset = recognizeProvider(baseUrl)
      const supportsExplicitCaching = preset?.supportsExplicitCaching ?? false

      const data: any = {
        name: name.trim(),
        type: providerType,
        authType: authType,
        apiStyle,
        email: email,
        baseUrl: providerType === 'google' ? GOOGLE_BASE_URL : (baseUrl.trim() || undefined),
        features: {
          ...(providerType === 'anthropic' ? { systemContentBlocks: useSystemArray } : {}),
          ...(supportsExplicitCaching ? { supportsExplicitCaching: true } : {}),
        },
        credentials: authType === 'google-oauth2' && oauthTokens ? {
          accessToken: oauthTokens.accessToken,
          refreshToken: oauthTokens.refreshToken,
          expiryDate: oauthTokens.expiryDate,
        } : {
          apiKey: (apiKeyTouched || !isEdit) ? (apiKey.trim() || undefined) : undefined,
        },
        enabled,
        // 价格折算已在详情弹窗确认时经 commitRow 完成，此处内存 models 纯透传落库
        models,
        customHeaders: customHeaders.filter(h => h.headerName.trim()),
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
        {...fade}
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[99998]"
      />
      {/* Modal */}
      <motion.div
        {...scaleFade}
        transition={{duration: 0.15, ease: 'easeOut'}}
        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none z-[99999]"
      >
        <div
          className="w-full max-w-[534px] max-h-[88vh] overflow-y-auto bg-white rounded-xl shadow-elevated border border-gray-200 pointer-events-auto"
          onClick={e => e.stopPropagation()}
         data-name="provider-edit-modal-div">
          {/* Header */}
          <div className="sticky top-0 bg-white z-10 px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">{isEdit ? '编辑服务商' : '添加服务商'}</h3>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors" data-name="provider-edit-modal-button">
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
                {CARD_PRESETS.map((p, i) => (
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
                   data-name={`provider-edit-modal-provider-type-${i}`}>{p.name}</button>
                ))}
              </div>
            </div>

            {/* 类型相关设置区 — 随 providerType 条件渲染，始终可见、不折叠（设计 §三 B2） */}
            {(providerType === 'openai' || providerType === 'custom') && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">API形态</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    {id: 'chat', name: 'Chat Completions'},
                    {id: 'responses', name: 'Responses API'},
                  ] as const).map((p, i) => (
                    <button key={p.id} onClick={() => setApiStyle(p.id)}
                      className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                        apiStyle === p.id ? 'bg-brand-50 border-brand-200 text-brand-600' : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                      }`}
                     data-name={`provider-edit-modal-api-style-${i}`}>{p.name}</button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">决定请求协议格式，影响所有对话请求的兼容性。Responses API 为 OpenAI 官方推荐协议；第三方兼容服务请保持 Chat Completions。</p>
              </div>
            )}

            {/* anthropic：system 内容块数组（含 cache_control 说明） */}
            {providerType === 'anthropic' && (
              <label className="flex items-start gap-2 text-xs font-medium text-gray-500">
                <input type="checkbox" checked={useSystemArray}
                  onChange={(e) => setUseSystemArray(e.target.checked)}
                  className="w-3.5 h-3.5 mt-0.5 rounded border-gray-300 text-brand-500 focus:ring-brand-300" data-name="provider-edit-modal-input"/>
                <div className="flex flex-col">
                  <span>启用 System Prompt 缓存</span>
                  <span className="text-[10px] text-gray-400">
                    将 system 以内容块数组发送并设置 cache_control，可降低多轮对话的延迟与成本；影响所有 Anthropic 对话请求
                  </span>
                </div>
              </label>
            )}

            {/* google：认证方式选择（SDK 固定端点，无需 Base URL） */}
            {providerType === 'google' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">认证方式</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    {id: 'api-key', name: 'AI Studio API Key'},
                    {id: 'google-oauth2', name: 'Google 账号登录'},
                  ] as const).map((p, i) => (
                    <button key={p.id} onClick={() => setAuthType(p.id)}
                      className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                        authType === p.id ? 'bg-brand-50 border-brand-200 text-brand-600' : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                      }`}
                     data-name={`provider-edit-modal-auth-type-${i}`}>{p.name}</button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">Google 走 SDK 固定端点，无需配置 Base URL；认证方式决定右侧凭据位的形态，影响模型拉取与测试请求。</p>
              </div>
            )}

            {/* ollama：本地服务提示 */}
            {providerType === 'ollama' && (              <div className="text-[10px] text-gray-400 px-3 py-2 rounded-md bg-gray-50 border border-gray-100">
                Ollama 为本地服务，无需 API 凭据与 Base URL 校验；请确认本地服务已启动并可访问。
              </div>
            )}

            {/* 服务商名称 + 凭据 同行双列；Base URL 独立成行（设计 §三 B2） */}
            <div className="grid grid-cols-2 gap-3">
            {/* 服务商名称 */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">服务商名称 <span className="text-red-400">*</span></label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="例如：OpenAI"
                className={`w-full px-2.5 py-1.5 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${
                  !isEdit && !name.trim() ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                }`} data-name="provider-edit-modal-name-input"/>
              {!isEdit && !name.trim() && <div className="text-[10px] text-red-400 mt-0.5">服务商名称不能为空</div>}
            </div>

            {/* 凭据位 — 随认证形态切换：通用 API Key ｜ Google 授权状态面板 ｜ AI Studio 密钥 */}
            {providerType !== 'google' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">API Key <span className="text-red-400">*</span></label>
                <div className="relative">
                  <input type={showApiKey ? 'text' : 'password'} value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true); setTestStates({}) }}
                    placeholder={isEncryptedKey ? '已加密' : 'sk-...'}
                    className={`w-full px-2.5 py-1.5 pr-8 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${
                      !isEdit && !apiKey.trim() ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                    }`} data-name="provider-edit-modal-api-key-input"/>
                  <button type="button" onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600" data-name="provider-edit-modal-toggle-api-key-button">
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
                {!isEdit && !apiKey.trim() && <div className="text-[10px] text-red-400 mt-0.5">API Key 不能为空</div>}
              </div>
            )}

            {/* google-oauth2：授权状态面板（替代 API Key 输入位，带标签对齐双列布局） */}
            {providerType === 'google' && authType === 'google-oauth2' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-gray-500 mb-1">授权状态</label>
                {authStatus === 'valid' ? (
                  <div className="flex items-center justify-between px-2.5 py-1.5 bg-green-50/50 border border-green-100 rounded-md">
                    <span className="text-[10px] text-green-600 font-medium flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      已授权{email ? ` · ${email}` : ''}
                    </span>
                    <button onClick={handleGoogleLogin} className="text-[10px] text-brand-500 hover:underline shrink-0" data-name="provider-edit-modal-switch-account-button">切换账号</button>
                  </div>
                ) : authStatus === 'expired' ? (
                  <div className="flex items-center justify-between px-2.5 py-1.5 bg-orange-50/50 border border-orange-100 rounded-md">
                    <span className="text-[10px] text-orange-500 font-medium flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                      授权已过期
                    </span>
                    <button onClick={handleGoogleLogin} className="text-[10px] text-brand-500 font-medium hover:underline shrink-0" data-name="provider-edit-modal-relogin-button">重新登录</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-gray-50/50 border border-gray-200 rounded-md">
                    <span className="text-[10px] text-gray-400">尚未授权，授权后可获取模型列表并测试</span>
                    <button onClick={handleGoogleLogin} disabled={isLoggingIn}
                      className="shrink-0 px-2.5 py-0.5 bg-brand-50 border border-brand-200 rounded text-[10px] text-brand-600 font-medium hover:bg-brand-100 transition-colors disabled:opacity-50" data-name="provider-edit-modal-google-login-button">
                      {isLoggingIn ? '正在授权...' : '去授权'}
                    </button>
                  </div>
                )}
                {oauthError && (
                  <div className="text-[10px] text-red-500 bg-red-50 border border-red-100 rounded px-2 py-1">
                    Google 授权失败：{oauthError}
                  </div>
                )}
              </div>
            )}

            {/* google api-key：AI Studio 密钥输入框 */}
            {providerType === 'google' && authType === 'api-key' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">AI Studio API Key <span className="text-red-400">*</span></label>
                <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true); setTestStates({}) }}
                  placeholder={isEncryptedKey ? '已加密' : 'AIza...'}
                  className={`w-full px-2.5 py-1.5 text-xs border rounded-md text-gray-700 placeholder-gray-300 focus:outline-none ${
                    !isEdit && !apiKey.trim() ? 'border-red-300 focus:border-red-400 bg-red-50' : 'border-gray-200 focus:border-brand-300 bg-white'
                  }`} data-name="provider-edit-modal-google-api-key-input"/>
                {!isEdit && !apiKey.trim() && <div className="text-[10px] text-red-400 mt-0.5">API Key 不能为空</div>}
              </div>
            )}
            </div>

            {/* Base URL — Google 使用 SDK 固定端点，无需用户配置（独立成行） */}
            {providerType !== 'google' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">API Base URL <span className="text-red-400">*</span></label>
                <div className="flex gap-2">
                <input type="text" value={baseUrl} onChange={(e) => handleBaseUrlChange(e.target.value)} onBlur={handleBaseUrlBlur}
                  placeholder="https://api.openai.com/v1"
                  className={`flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${
                    !isEdit && !baseUrl.trim() ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                  }`} data-name="provider-edit-modal-base-url-input"/>
                {/* 自定义请求头入口：N>0 绿色标识已配置 */}
                <button type="button" onClick={openHeadersModal}
                  className={`shrink-0 px-2 py-1 text-xs border rounded-md bg-white transition-colors whitespace-nowrap ${
                    customHeaders.length > 0
                      ? 'border-emerald-300 text-emerald-600 hover:border-emerald-400 hover:bg-emerald-50/50'
                      : 'border-gray-200 text-brand-500 hover:border-brand-300 hover:bg-brand-50/50'
                  }`} data-name="provider-edit-modal-custom-headers-button">
                  ⚙ 自定义请求头 ({customHeaders.length})
                </button>
                </div>
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

            {/* 启用开关 */}
            <label className="flex items-center gap-2 text-xs font-medium text-gray-500">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-gray-300 text-brand-500 focus:ring-brand-300" data-name="provider-edit-modal-enabled-checkbox"/>
              启用此服务商
            </label>

            {/* 拉取结果面板 — 位于工具栏与模型表之间（B6） */}
            {fetchedResult && (
              <div className="mb-2 border border-brand-200 bg-brand-50/50 rounded-md p-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[11px] font-medium text-gray-600 shrink-0">已获取 {fetchedResult.length} 个模型</span>
                  <input value={fetchSearch} onChange={(e) => setFetchSearch(e.target.value)} placeholder="搜索模型..."
                    className="flex-1 min-w-0 px-2 py-1 text-[10px] border border-gray-200 rounded-md focus:outline-none focus:border-brand-300" data-name="provider-edit-modal-fetch-search-input"/>
                  <ThemedSelect
                    value={fetchTypeFilter}
                    onChange={(v) => setFetchTypeFilter(v as any)}
                    options={[
                        {value: 'all', label: '全部类型'},
                        {value: 'text', label: '文本'},
                        {value: 'image', label: '图像'},
                        {value: 'voice', label: '音频'},
                        {value: 'video', label: '视频'},
                        {value: 'music', label: '音乐'},
                        {value: 'embedding', label: '向量'},
                    ]}
                    ariaLabel="价目表类型过滤"
                  />
                  <button onClick={() => setSelectedIds(new Set(fetchedResult.map(m => m.id)))} className="text-[10px] text-brand-500 hover:underline shrink-0" data-name="provider-edit-modal-select-all-button">全选</button>
                  <button onClick={() => setSelectedIds(new Set())} className="text-[10px] text-gray-400 hover:underline shrink-0" data-name="provider-edit-modal-clear-selection-button">清空</button>
                </div>
                <div className="max-h-40 overflow-y-auto space-y-0.5 mb-1.5">
                  {filteredFetched.map((m, i) => (
                    <label key={m.id} className="flex items-center gap-1.5 text-[10px] font-mono text-gray-600 cursor-pointer">
                      <input type="checkbox" checked={selectedIds.has(m.id)}
                        onChange={(e) => setSelectedIds(prev => { const s = new Set(prev); if (e.target.checked) s.add(m.id); else s.delete(m.id); return s })}
                        className="w-3 h-3 rounded border-gray-300 text-brand-500" data-name={`provider-edit-modal-model-checkbox-${i}`}/>
                      <span className="flex-1 truncate">{m.id}</span>
                      <span className="text-[9px] px-1 rounded bg-gray-100 text-gray-400 shrink-0">{m.modelType || 'text'}</span>
                    </label>
                  ))}
                  {filteredFetched.length === 0 && <div className="text-[10px] text-gray-400 py-1 text-center">无匹配模型</div>}
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={handleReplace} className="px-2 py-1 text-[10px] bg-brand-500 text-white rounded-md hover:bg-brand-600" data-name="provider-edit-modal-replace-button">替换</button>
                  <button onClick={handleMerge} className="px-2 py-1 text-[10px] border border-brand-200 text-brand-600 rounded-md hover:bg-brand-50/50" data-name="provider-edit-modal-merge-button">合并</button>
                  <button onClick={() => { setFetchedResult(null); setSelectedIds(new Set()) }} className="px-2 py-1 text-[10px] text-gray-400 hover:text-gray-600" data-name="provider-edit-modal-cancel-fetch-button">取消</button>
                  <span className="text-[9px] text-gray-400 ml-auto">已选 {selectedIds.size} 个</span>
                </div>
              </div>
            )}

            {fetchError && (
              <div className="mb-2 text-[10px] text-red-400">{fetchError}</div>
            )}

            {/* 模型管理 */}
            <ModelTable
              models={models}
              testStates={testStates}
              canTest={canTest}
              credentialBlockReason={credentialBlockReason}
              batchTesting={batchTesting}
              batchProgress={batchProgress}
              toolbarExtra={
                <>
                  {fillNotice && (
                    <span className={`text-[10px] ${fillNotice.kind === 'error' ? 'text-red-400' : 'text-gray-400'}`}>
                      {fillNotice.text}
                    </span>
                  )}
                  <button onClick={handleFetchModels} disabled={fetching || !canFetch}
                  title={!canFetch ? credentialBlockReason : '自动获取模型列表'}
                  className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" data-name="provider-edit-modal-fetch-models-button">
                  {fetching
                    ? <span className="w-3 h-3 border-2 border-brand-300 border-t-transparent rounded-full animate-spin" />
                    : <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6"/></svg>}
                  自动获取
                </button>
                </>
              }
              onOpenDetail={(id) => setDetailModelId(id)}
              onNameChange={(id, newName) => {                setModels(models.map(m => m.id === id ? {...m, name: newName} : m))
                // 模型名称变更后清空该模型测试结果，避免旧结果匹配新名称造成误导
                setTestStates(prev => { const next = {...prev}; delete next[id]; return next })
              }}
              onTest={handleTestModel}
              onTestAll={handleTestAll}
              onCancelBatch={() => { batchCancelRef.current = true }}
              onDelete={(id) => setModels(models.filter(m => m.id !== id))}
              onAdd={(newName) => setModels([...models, {id: crypto.randomUUID(), name: newName || '', enabled: true}])}
            />
          </div>

          {/* Footer */}
          <div className="sticky bottom-0 bg-[var(--surface)] border-t border-gray-200 px-5 py-3 flex items-center justify-between">
            <div className="text-[11px] text-red-400">{nameValidationError || formValidationError || modelValidationError || ''}</div>
            <div className="flex items-center gap-2">
              <button onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors" data-name="provider-edit-modal-cancel-button">
                取消
              </button>
              <button onClick={handleSave} disabled={saving || !name.trim() || !!nameValidationError || !!modelValidationError || !!formValidationError}
                className="px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5" data-name="provider-edit-modal-save-button">
                {saving && <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                {isEdit ? '保存' : '添加'}
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* 模型详情弹窗（价格/参数编辑收敛于此；确定 → 更新内存 models，随外层「保存」落库） */}
      {detailModelId && (
        <ModelDetailModal
          open
          providerName={name.trim() || '未命名服务商'}
          model={models.find(m => m.id === detailModelId) ?? null}
          onClose={() => setDetailModelId(null)}
          onConfirm={(next) => setModels(prev => prev.map(m => m.id === next.id ? next : m))}
          rate={rate}
          settingsDefaults={{defaultTemperature: settingsModel.defaultTemperature, defaultMaxTokens: settingsModel.defaultMaxTokens}}
        />
      )}
      {/* 二级弹窗：自定义请求头管理（草稿模式，确定写回主表单） */}
      {showHeadersModal && (
        <>
          <motion.div {...fade} className="fixed inset-0 bg-black/35 backdrop-blur-sm z-[100000]" />
          <motion.div
            {...scaleFade}
            transition={{duration: 0.15, ease: 'easeOut'}}
            className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none z-[100001]"
          >
            <div
              className="w-full max-w-[480px] max-h-[70vh] overflow-y-auto bg-white rounded-xl shadow-elevated border border-gray-200 pointer-events-auto"
              onClick={e => e.stopPropagation()}
             data-name="provider-edit-modal-custom-headers-div">
              {/* 标题 */}
              <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
                <h4 className="text-[13px] font-semibold text-gray-800">自定义请求头</h4>
                <button onClick={() => setShowHeadersModal(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors" data-name="provider-edit-modal-custom-headers-close-button">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>

              {/* 说明 */}
              <div className="px-5 pt-3">
                <p className="text-[10px] text-gray-400 leading-relaxed">
                  为该服务商的所有请求附加 HTTP 头。值 = 固定前缀 + 系统变量（可选），变量在每次请求时自动解析。
                </p>
              </div>

              {/* 头行列表 */}
              <div className="px-5 py-3 space-y-2">
                {headersDraft.map((h) => {
                  const variable = HEADER_VARIABLES.find(v => v.value === (h.variable || ''))
                  const hasPreview = !!h.prefix || !!variable?.sample
                  const rowInvalid = isHeaderRowInvalid(h)
                  return (
                    <div key={h.id}>
                      <div className="flex gap-1.5 items-start">
                        <ThemedCombobox value={h.headerName}
                          onChange={(v) => updateHeaderDraft(h.id, {headerName: v})}
                          suggestions={HEADER_NAME_SUGGESTIONS}
                          placeholder="X-My-Header"
                          className="w-32 shrink-0"
                          ariaLabel="请求头名称"/>
                        <input type="text" value={h.prefix || ''} onChange={(e) => updateHeaderDraft(h.id, {prefix: e.target.value})}
                          placeholder="固定前缀，可空"
                          className={`flex-1 min-w-0 px-2 py-1.5 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${rowInvalid ? 'border-red-300' : 'border-gray-200 focus:border-brand-300'}`}
                          data-name="provider-edit-modal-header-prefix-input"/>
                        <span className="shrink-0 w-3.5 text-center leading-[30px] text-xs text-gray-400">+</span>
                        <ThemedSelect value={h.variable || ''} onChange={(v) => updateHeaderDraft(h.id, {variable: (v || undefined) as ProviderCustomHeader['variable']})}
                          options={HEADER_VARIABLES.map(v => ({value: v.value || '', label: v.label}))}
                          className="w-[88px] shrink-0"
                          error={rowInvalid}
                          ariaLabel="系统变量"/>
                        <button type="button" title="删除" onClick={() => setHeadersDraft(prev => prev.filter(x => x.id !== h.id))}
                          className="shrink-0 p-1 text-gray-300 hover:text-red-400 transition-colors" data-name="provider-edit-modal-header-delete-button">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>
                      </div>
                      {/* 行预览：前缀灰、变量品牌蓝高亮；两者皆空不显示 */}
                      {rowInvalid ? (
                        <div className="text-[10px] text-red-400 pl-[136px] mt-0.5">
                          固定前缀与系统变量不能同时为空
                        </div>
                      ) : hasPreview && (
                        <div className="font-mono text-[10.5px] text-gray-400 pl-[136px] mt-0.5" data-name="provider-edit-modal-header-preview">
                          预览：{h.prefix && <span className="text-gray-500">{h.prefix}</span>}
                          {variable?.sample && <span className="text-brand-600 bg-brand-50 rounded px-0.5">{variable.sample}</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
                <button type="button"
                  onClick={() => setHeadersDraft(prev => [...prev, {id: crypto.randomUUID(), providerId: provider?.id || '', headerName: ''}])}
                  className="w-full py-1.5 border border-dashed border-gray-300 rounded-md text-[11px] text-gray-400 hover:text-brand-500 hover:border-brand-300 transition-colors"
                  data-name="provider-edit-modal-add-header-button">
                  ＋ 添加请求头
                </button>
              </div>

              {/* 底部按钮 */}
              <div className="border-t border-gray-100 px-5 py-3 flex justify-end gap-2">
                <button onClick={() => setShowHeadersModal(false)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors" data-name="provider-edit-modal-custom-headers-cancel-button">
                  取消
                </button>
                <button onClick={confirmHeadersModal} disabled={headersDraft.some(isHeaderRowInvalid)}
                  className="px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" data-name="provider-edit-modal-custom-headers-confirm-button">
                  确定
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </>
  )
}
