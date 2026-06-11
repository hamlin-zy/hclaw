import {useEffect, useMemo, useRef, useState} from 'react'
import {motion} from 'framer-motion'
import type {LLMProvider, ProviderModel} from '../../stores/llmStore'
import {useLLMStore} from '../../stores/llmStore'
import {isEncrypted} from '../../lib/crypto'

interface ProviderEditModalProps {
  mode: 'add' | 'edit'
  provider?: LLMProvider | null
  onClose: () => void
  onSave: (data: Omit<LLMProvider, 'id'> & { models?: ProviderModel[] }) => Promise<void>
}

const PROVIDER_PRESETS: Array<{ id: LLMProvider['type']; name: string; baseUrl: string }> = [
  {id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1'},
  {id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com'},
  {id: 'google', name: 'Google', baseUrl: ''},
  {id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434'},
]

export default function ProviderEditModal({mode, provider, onClose, onSave}: ProviderEditModalProps) {
  const {getDecryptedApiKey} = useLLMStore()
  const isEdit = mode === 'edit'

  // ─── 表单状态 ──────────────────────────────────────
  const [name, setName] = useState(provider?.name || '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '')
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

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true)
    try { await window.electronAPI?.authGoogleLogin() } catch { setIsLoggingIn(false) }
  }

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
        baseUrl: baseUrl.trim() || undefined,
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
                {PROVIDER_PRESETS.map((p) => (
                  <button key={p.id} onClick={() => {
                    setProviderType(p.id)
                    if (p.id === 'google') {
                      // 切到 Google 保持当前 authType
                    } else {
                      setAuthType('api-key')
                    }
                    if (!isEdit) {
                      setName(p.name)
                    }
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
                <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className={`w-full px-2.5 py-1.5 text-xs bg-white border rounded-md text-gray-700 placeholder-gray-400 focus:outline-none ${
                    !isEdit && !baseUrl.trim() ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                  }`} />
                {!isEdit && !baseUrl.trim() && <div className="text-[10px] text-red-400 mt-0.5">API Base URL 不能为空</div>}
                {providerType === 'anthropic' && baseUrl && !baseUrl.endsWith('anthropic') && (
                  <div className="mt-1 text-[10px] text-amber-500 flex items-start gap-1">
                    <svg className="w-3 h-3 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span>请注意 anthropic 类型 API，URL 应该以 anthropic 结尾，如果您确认没问题，可以忽略本提示。这只是一个提示，不影响保存。</span>
                  </div>
                )}
                {providerType === 'openai' && baseUrl && !baseUrl.endsWith('/v1') && (
                  <div className="mt-1 text-[10px] text-amber-500 flex items-start gap-1">
                    <svg className="w-3 h-3 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span>请注意 OpenAI 类型 API，URL 应该以 /v1 结尾，如果您确认没问题，可以忽略本提示。这只是一个提示，不影响保存。</span>
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
                    <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true) }}
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
                    onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true) }}
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
                <span className="text-[10px] text-gray-400">{models.length} 个模型</span>
              </div>

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
                          onChange={(e) => setModels(models.map(m => m.id === model.id ? {...m, name: e.target.value} : m))}
                          className={`flex-1 min-w-0 px-2 py-1 text-[11px] font-mono bg-white border rounded text-gray-700 focus:outline-none placeholder-gray-400 ${
                            isEmpty || isDuplicate ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                          }`} />
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
