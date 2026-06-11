import {Component, type ReactNode, useEffect, useState} from 'react'
import {AnimatePresence} from 'framer-motion'
import TitleBar from './components/TitleBar'
import MenuBar from './components/MenuBar'
import ConversationSidebar from './components/ConversationSidebar'
import MainWorkspace from './components/MainWorkspace'
import SidePanels from './components/SidePanels'
import MenuDialogRenderer from './components/MenuDialogRenderer'
import DiffModal from './components/DiffModal'
import AskUserModal from './components/AskUserModal'
import ConfirmDialog, {confirm} from './components/ConfirmDialog'
import PermissionConfirmModal from './components/PermissionConfirmModal'
import CompactToolPopup from './components/message-list/compact-popup'
import CombinedCardPopup from './components/message-list/compact-popup/CombinedCardPopup'
import {useAgentStore} from './stores/agentStore'
import {useConversationStore} from './stores/conversationStore'
import {useLLMStore} from './stores/llmStore'
import {useModelSchemeStore} from './stores/modelSchemeStore'
import {useSkillStore} from './stores/skillStore'
import {useHookStore} from './stores/hookStore'
import {useThemeStore, resolveAndApplyTheme} from './stores/themeStore'
import {useSettingsStore} from './stores/settingsStore'
import {useSidebarStore} from './stores/sidebarStore'
import {useGlobalHotkeys} from './hooks/useGlobalHotkeys'
import TooltipPortal from './components/common/TooltipPortal'
import type {ModelType} from '@shared/types'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

/**
 * 默认方案的角色模板
 * fillEndpoint: 是否用当前可用 provider/model 填充 endpointId/modelId
 */
const DEFAULT_ROLE_TEMPLATES: Array<{role: string; modelType: ModelType; enabled: boolean; fillEndpoint: boolean}> = [
    {role: 'primary', modelType: 'text', enabled: true, fillEndpoint: true},
    {role: 'lightweight', modelType: 'text', enabled: false, fillEndpoint: true},
    {role: 'reasoning', modelType: 'text', enabled: false, fillEndpoint: true},
    {role: 'image_understanding', modelType: 'image', enabled: false, fillEndpoint: false},
    {role: 'video_understanding', modelType: 'video', enabled: false, fillEndpoint: false},
    {role: 'image_generation', modelType: 'image', enabled: false, fillEndpoint: false},
    {role: 'video_generation', modelType: 'video', enabled: false, fillEndpoint: false},
    {role: 'voice_clone', modelType: 'voice', enabled: false, fillEndpoint: false},
    {role: 'voice_synthesis', modelType: 'voice', enabled: false, fillEndpoint: false},
    {role: 'music_generation', modelType: 'music', enabled: false, fillEndpoint: false},
]

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-gray-50">
          <div className="text-center space-y-3">
            <div className="text-4xl">⚠️</div>
            <h2 className="text-lg font-medium text-gray-700">应用出现了错误</h2>
            <p className="text-sm text-gray-400 max-w-md">{this.state.error?.message}</p>
            <button
              onClick={() => { this.setState({ hasError: false }); window.location.reload() }}
              className="px-4 py-2 text-sm bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors"
            >
              重新加载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 处理方案初始化错误
 * 尝试修复方案配置或创建新的默认方案
 * 使用新的 roles 数组结构
 */
async function handleSchemeInitializationError(
    llmState: ReturnType<typeof useLLMStore.getState>,
    errorMessage: string
): Promise<void> {
    console.error('[App] 方案初始化失败:', errorMessage)

    // 检查是否有可用的 provider
    const availableProvider = llmState.providers.find(p => p.enabled && p.credentials?.apiKey)
    if (!availableProvider) {
        console.warn('[App] 没有可用的 provider，无法自动修复方案')
        return
    }

    const availableModel = availableProvider.models.find(m => m.enabled)
    if (!availableModel) {
        console.warn('[App] Provider 没有可用的模型')
        return
    }

    // 获取或创建默认方案
    const schemeStore = useModelSchemeStore.getState()
    let activeScheme = schemeStore.getActiveScheme()

    // Helper: 从 roles 数组中获取指定 role 的配置
    const getRole = (scheme: typeof activeScheme, role: string) =>
        scheme?.roles.find(r => r.role === role)

    if (!activeScheme) {
        // 创建新的默认方案（从模板生成 roles）
        const newScheme = {
            name: '默认方案',
            description: '自动创建的默认方案',
            enabled: true,
            roles: DEFAULT_ROLE_TEMPLATES.map(t => ({
                id: crypto.randomUUID(),
                role: t.role,
                endpointId: t.fillEndpoint ? availableProvider.id : '',
                modelId: t.fillEndpoint ? availableModel.id : '',
                modelType: t.modelType,
                enabled: t.enabled,
            })),
        }
        const schemeId = schemeStore.addScheme(newScheme)
        activeScheme = schemeStore.schemes.find(s => s.id === schemeId) ?? null
        console.log('[App] 创建新方案:', activeScheme?.name)
    } else {
        // 修复现有方案的 endpointId（使用 roles 数组结构）
        const primaryRole = getRole(activeScheme, 'primary')
        const needsUpdate =
            !primaryRole ||
            !llmState.providers.find(p => p.id === primaryRole.endpointId) ||
            !availableProvider.models.find(m => m.id === primaryRole.modelId)

        if (needsUpdate) {
            console.log('[App] 修复现有方案的配置')

            // 更新所有角色的 endpointId 和 modelId
            const updatedRoles = activeScheme.roles.map(role => ({
                ...role,
                endpointId: availableProvider.id,
                modelId: availableModel.id,
            }))

            schemeStore.updateScheme(activeScheme.id, {roles: updatedRoles})
            // 重新获取更新后的 scheme
            activeScheme = schemeStore.getActiveScheme()
        }
    }

    // 重新尝试同步到主进程
    if (!activeScheme) {
        console.warn('[App] 无法获取有效的方案配置')
        return
    }

    try {
        const decryptedProviders = await llmState.getAllDecryptedProviders()
        const updateResult = await window.electronAPI?.updateModelScheme?.({
            schemeId: activeScheme.id,
            scheme: activeScheme,
            providers: decryptedProviders,
        })

        if (!updateResult?.success) {
            console.error('[App] 方案修复失败:', updateResult?.error)
        }
    } catch (err) {
        console.error('[App] 方案修复异常:', err)
    }
}

/**
 * 等待 zustand persist store 完成 rehydration
 * 替代盲等 500ms + 100ms 轮询，改为 50ms 细粒度轻量轮询 + 超时兜底
 *
 * 为什么不用 subscribe？
 * zustand persist 的 onRehydrateStorage 在 set() 完成后直接 mutate state.hasRehydrated，
 * 不会触发 subscribe 回调，故仍需轻量轮询。
 *
 * @param storeSelector 返回 hasRehydrated 字段的函数
 * @param timeoutMs 超时回退
 */
function waitForStoreRehydration(
    storeSelector: () => boolean,
    timeoutMs = 5000
): Promise<void> {
    return new Promise((resolve) => {
        if (storeSelector()) {
            resolve()
            return
        }
        const interval = setInterval(() => {
            if (storeSelector()) {
                clearInterval(interval)
                clearTimeout(timer)
                resolve()
            }
        }, 50)
        const timer = setTimeout(() => {
            clearInterval(interval)
            resolve()
        }, timeoutMs)
    })
}

/**
 * 同步模型方案到主进程
 * 统一处理：解密 providers → 同步到主进程 → 错误修复
 * 供初始化流程和 provider 变更监听共享使用
 */
async function syncModelSchemeToMain(llmState: ReturnType<typeof useLLMStore.getState>): Promise<{
    success: boolean;
    decryptedProviders?: import('./stores/llmStore').LLMProvider[]
}> {
    const scheme = useModelSchemeStore.getState().getActiveScheme()
    if (!scheme) {
        console.warn('[App] 同步方案失败：没有激活的方案')
        return { success: false }
    }

    try {
        const decryptedProviders = await llmState.getAllDecryptedProviders()
        if (decryptedProviders.length === 0) {
            console.error('[App] 解密后 providers 为空！无法同步模型方案')
            return { success: false }
        }

        // 同步到主进程全局管理器
        const result = await window.electronAPI?.updateModelScheme?.({
            schemeId: scheme.id,
            scheme,
            providers: decryptedProviders,
        })

        if (result && !result.success) {
            console.error('[App] 方案同步失败:', result.error)
            await handleSchemeInitializationError(llmState, result.error || 'unknown error')
            return { success: false }
        }

        return { success: true, decryptedProviders }
    } catch (err: any) {
        console.error('[App] 方案同步异常:', err)
        await handleSchemeInitializationError(llmState, err?.message || err)
        return { success: false }
    }
}

export default function App() {
  const registerStreamListener = useAgentStore((s) => s.registerStreamListener)
  const theme = useThemeStore((s) => s.theme)
  const {leftCollapsed, rightCollapsed} = useSidebarStore()

  // 注册系统内快捷键（非全局快捷键）
  useGlobalHotkeys()

  useEffect(() => {
    document.documentElement.classList.remove('dark', 'yuanshandai', 'shiyangjin')
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else if (theme === 'yuanshandai') {
      document.documentElement.classList.add('yuanshandai')
    } else if (theme === 'shiyangjin') {
      document.documentElement.classList.add('shiyangjin')
    }

    // ── 清除 index.html 内联脚本注入的 CSS 变量 inline styles ──
    // index.html 为防首次绘制闪烁，在内联脚本中用 rootStyle.setProperty() 注入了 CSS 变量。
    // 但这些 inline styles 优先级高于任何 CSS class 定义（包括 :root 和 .dark），
    // 导致切换主题后 var() 引用的元素仍显示旧值，不会随 class 切换。
    // 此处全部清除，让 globals.css 的 :root / .dark 选择器接管主题控制。
    const ROOT_CSS_VARS = [
      '--surface', '--surface-muted', '--surface-elevated', '--surface-overlay',
      '--text-primary', '--text-secondary', '--text-muted', '--text-inverse',
      '--border', '--border-muted', '--border-emphasis',
      '--brand-primary', '--brand-hover', '--brand-muted',
      '--success', '--warning', '--error', '--info',
    ]
    const rootStyle = document.documentElement.style
    for (const prop of ROOT_CSS_VARS) {
      rootStyle.removeProperty(prop)
    }

    window.electronAPI?.setWindowTheme?.(theme)
  }, [theme])

  useEffect(() => {
    const init = async () => {
      try {
        await Promise.all([
          useConversationStore.getState().loadConversations(),
          useSettingsStore.getState().loadSettings(),
          useHookStore.getState().fetchHooks(),
          useSkillStore.getState().refreshSkills(),
        ])

        // 应用启动时同步主题设置
        const theme = useSettingsStore.getState().settings.ui.theme
        resolveAndApplyTheme(theme)

        // 等待 llmStore + modelSchemeStore rehydration 完成
        // 并行等待，50ms 细粒度轮询，5s 超时兜底
        await Promise.all([
          waitForStoreRehydration(() => useLLMStore.getState().hasRehydrated),
          waitForStoreRehydration(() => useModelSchemeStore.getState().hasRehydrated),
        ])

        const llmState = useLLMStore.getState()

        if (!llmState.activeProviderId) {
          llmState.setActiveProvider(llmState.providers[0]?.id)
        }

        // 同步当前方案到主进程的全局管理器
        const scheme = useModelSchemeStore.getState().getActiveScheme()

        if (scheme && llmState.providers.length > 0) {
          // 解密 providers → 同步到主进程 → 错误修复
          const syncResult = await syncModelSchemeToMain(llmState)

          // 同步成功后执行客户端预热
          if (syncResult.success && syncResult.decryptedProviders) {
            try {
              const warmupResult = await window.electronAPI?.agentWarmupClients?.({
                scheme,
                providers: syncResult.decryptedProviders,
              })
              if (warmupResult && !warmupResult.success) {
                console.warn('[App] 客户端预热失败:', warmupResult.error)
              }
            } catch (warmupErr) {
              console.warn('[App] 客户端预热异常:', warmupErr)
            }
          }
        }
      } catch (err) {
        // 静默处理错误
      }
    }
    // 不阻塞渲染：init 在后台执行，组件自行管理 loading 状态
    init()
  }, [])

  // ── 监听 system_manage 等外部来源的配置变更（如 Agent 通过工具修改设置） ──
  useEffect(() => {
    const cleanup = window.electronAPI?.receive?.('settings-updated', (settings: any) => {
      if (settings?.ui) {
        useSettingsStore.getState().loadSettings()
        if (settings.ui.theme) {
          resolveAndApplyTheme(settings.ui.theme)
        }
      }
    })

    return () => {
      cleanup?.()
    }
  }, [])

    // ── 监听服务商配置变更，同步到主进程全局管理器 ──
    useEffect(() => {
      const buildSignature = (providers: ReturnType<typeof useLLMStore.getState>['providers']) =>
        providers.map(p =>
          `${p.id}|${p.enabled}|${p.type}|${p.baseUrl || ''}|${p.models.map(m => `${m.id}:${m.enabled}`).join('/')}|${p.credentials?.apiKey?.length || 0}|${p.credentials?.accessToken?.length || 0}|${p.credentials?.expiryDate || 0}`
        ).join(',')

      let prevProvidersSignature = buildSignature(useLLMStore.getState().providers)

      const unsubscribe = useLLMStore.subscribe((state) => {
        const currentSignature = buildSignature(state.providers)
        if (currentSignature !== prevProvidersSignature) {
          prevProvidersSignature = currentSignature
          ;(async () => {
            await syncModelSchemeToMain(state)
          })()
        }
      })

      return unsubscribe
    }, [])

  // 注册 Agent 流式监听器（只注册一次）
  useEffect(() => {
    const cleanup = registerStreamListener()
    return cleanup
  }, [registerStreamListener])

  // ── 页面刷新后恢复正在运行的 Agent 会话 ──
  // registerStreamListener 是纯同步操作（注册 IPC onAgentStream 回调），
  // effect 执行顺序保证它已先于本 effect 完成注册，无需延迟。
  // HMR 时 registerStreamListener 引用变化 → 此 effect 重新执行 → 自动恢复
  useEffect(() => {
    useAgentStore.getState().recoverSessions()
  }, [registerStreamListener])

  // 注册退出时刷盘监听
  useEffect(() => {
    const unsub = window.electronAPI?.onFlushSave?.(() => {
      useConversationStore.getState().saveMessages()
    })
    return () => { if (unsub) unsub() }
  }, [])

  // ── 全局右键粘贴处理 ──────────────────────────────
  // 所有 input/textarea 的右键自动粘贴剪贴板文字
  // InputArea 已有自己的 handler（支持图片粘贴），通过 stopPropagation 阻止重复触发
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // 只处理 INPUT 和 TEXTAREA 元素
      if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') return

      // 跳过已有自定义 handler 的元素（如 InputArea textarea）
      // 这些元素通过 stopPropagation 阻止了事件冒泡，不会到达这里
      e.preventDefault()

      // 异步读取剪贴板文本并插入到光标位置
      setTimeout(async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (!text) return
          // execCommand('insertText') 会触发原生 input 事件
          // React 会捕获并调用对应的 onChange，更新组件状态
          document.execCommand('insertText', false, text)
        } catch {
          // 剪贴板读取失败（无权限或无内容）
        }
      }, 0)
    }

    document.addEventListener('contextmenu', handleContextMenu)
    return () => document.removeEventListener('contextmenu', handleContextMenu)
  }, [])

  return (
    <ErrorBoundary>
      {/* macOS Tooltip Portal（突破 overflow: hidden 祖先容器裁剪） */}
      {typeof document !== 'undefined' && document.documentElement.classList.contains('darwin') && <TooltipPortal />}
      <div className="window-container">
        <TitleBar />
        <MenuBar />
        <main className="flex-1 flex overflow-hidden px-2 py-2 gap-2"
              style={{minHeight: 0, marginTop: 0, marginBottom: 0}}>
          {/* 左侧边栏卡片 - 折叠时隐藏 */}
          {!leftCollapsed && (
            <div
              className="bg-[var(--surface)] rounded-lg shadow-card border border-[var(--border)] overflow-hidden flex flex-col transition-all"
              style={{width: 'var(--sidebar-width)'}}>
              <ConversationSidebar/>
            </div>
          )}
          {/* 中间主内容卡片 */}
          <div
            className="flex-1 flex flex-col min-w-0 transition-all overflow-hidden">
            <MainWorkspace/>
          </div>
          {/* 右侧面板卡片 - 折叠时隐藏 */}
          {!rightCollapsed && (
            <div className="w-sidebar flex-shrink-0 min-h-0 flex flex-col transition-all h-full">
              <SidePanels/>
            </div>
          )}
        </main>
        <AnimatePresence>
          <MenuDialogRenderer key="menu-dialog" />
          <DiffModal key="diff-modal" />
          <AskUserModal key="ask-user-modal"/>
          <ConfirmDialog key="confirm-dialog"/>
          <PermissionConfirmModal key="permission-confirm-modal"/>
          <CompactToolPopup key="compact-tool-popup"/>
          <CombinedCardPopup key="combined-card-popup"/>
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  )
}

// ── 闲置期自动 GC（仅限 electron 渲染进程 + expose-gc 启用时）──
if (typeof window !== 'undefined' && typeof (window as any).gc === 'function' && 'requestIdleCallback' in window) {
    const MIN_GC_INTERVAL = 45000
    let lastGc = 0

    const tryGc = () => {
        const now = Date.now()
        if (now - lastGc < MIN_GC_INTERVAL) return
        ;(window as any).requestIdleCallback((idle: {didTimeout: boolean}) => {
            if (idle.didTimeout) return
            ;(window as any).gc()
            lastGc = now
        }, {timeout: 5000})
    }

    setInterval(tryGc, 60000)
    setTimeout(tryGc, 15000)
}
