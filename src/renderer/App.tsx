import {Component, type ReactNode, useEffect} from 'react'
import {AnimatePresence} from 'framer-motion'
import TitleBar from './components/TitleBar'
import MenuBar from './components/MenuBar'
import ConversationSidebar from './components/ConversationSidebar'
import MainWorkspace from './components/MainWorkspace'
import MenuDialogRenderer from './components/MenuDialogRenderer'
import DiffModal from './components/DiffModal'
import AskUserModal from './components/AskUserModal'
import ConfirmDialog from './components/ConfirmDialog'
import UsageStatsDialog from './components/dialogs/UsageStatsDialog'
import PermissionConfirmModal from './components/PermissionConfirmModal'
import CompactToolPopup from './components/message-list/compact-popup'
import CombinedCardPopup from './components/message-list/compact-popup/CombinedCardPopup'
import {useAgentStore} from './stores/agentStore'
import {useConversationStore} from './stores/conversationStore'
import {useLLMStore} from './stores/llmStore'
import {useModelSchemeStore} from './stores/modelSchemeStore'
import {useToolStore} from './stores/toolStore'
import {usePromptSchemeStore} from './stores/promptSchemeStore'
import {useSkillStore} from './stores/skillStore'
import {useAgentTemplateStore} from './stores/agentTemplateStore'
import {useThemeStore, resolveAndApplyTheme} from './stores/themeStore'
import {useSettingsStore} from './stores/settingsStore'
import {useSidebarStore} from './stores/sidebarStore'
import {useUpdaterStore} from './stores/updaterStore'
import {usePluginUpdateStore} from './stores/pluginUpdateStore'
import {useMenuBarStore} from './stores/menuBarStore'
import {useGlobalHotkeys} from './hooks/useGlobalHotkeys'
import TooltipPortal from './components/common/TooltipPortal'
import {createGcScheduler} from './lib/gcScheduler'
import {syncExchangeRate} from './lib/format'
import {registerStoreMemorySources} from './utils/memorySources'
import {startWatermarkTimer} from './utils/memoryWatermark'
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
    {role: 'audio_understanding', modelType: 'voice', enabled: false, fillEndpoint: false},
    {role: 'video_understanding', modelType: 'video', enabled: false, fillEndpoint: false},
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
  const {leftCollapsed} = useSidebarStore()
  const background = useSettingsStore((s) => s.settings.ui.background)

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

  // ── 本地图片背景：控制 bg-enabled class + 背景层/遮罩层变量 ──
  useEffect(() => {
    const enabled = background?.enabled && !!background.imagePath
    document.documentElement.classList.toggle('bg-enabled', !!enabled)
    if (enabled) {
      // 遮罩/模糊通过 CSS 变量传递给样式层
      document.documentElement.style.setProperty('--bg-overlay', String((background.overlay ?? 40) / 100))
      document.documentElement.style.setProperty('--bg-blur', `${background.blur ?? 16}px`)
      // 气泡后层/卡片毛玻璃的 surface 透明度：跟随 overlay 滑杆，且按主题区分区间。
      // 深色主题（surface 近黑）40-90%；浅色主题（surface 纯白）25-70%——
      // 浅色下若保持同样区间，白色毛玻璃层叠会变成不透明白雾盖住背景图。
      const isDark = theme === 'dark' || theme === 'yuanshandai'
      const overlayRatio = (background.overlay ?? 40) / 100
      const alphaPct = isDark
          ? Math.round((0.40 + overlayRatio * 0.50) * 100)
          : Math.round((0.25 + overlayRatio * 0.45) * 100)
      document.documentElement.style.setProperty('--bg-surface-alpha', `${alphaPct}%`)
      // 内部列表项（右侧栏规则项/待办项）遮挡强度 = 主层 × 0.7
      document.documentElement.style.setProperty('--bg-surface-alpha-inner', `${Math.round(alphaPct * 0.7)}%`)
    }
    return () => {
      document.documentElement.style.removeProperty('--bg-overlay')
      document.documentElement.style.removeProperty('--bg-blur')
      document.documentElement.style.removeProperty('--bg-surface-alpha')
      document.documentElement.style.removeProperty('--bg-surface-alpha-inner')
    }
  }, [background?.enabled, background?.imagePath, background?.overlay, background?.blur, theme])

  useEffect(() => {
    const init = async () => {
      try {
        await Promise.all([
          useConversationStore.getState().loadConversations(),
          useSettingsStore.getState().loadSettings(),
          useSkillStore.getState().refreshSkills(),
          // ★ 历史 /能力 消息降级渲染依赖 agent 能力名集合，
          //   缺失会导致重启后 agent 类命令（如 /code-simplifier）无法渲染徽章
          useAgentTemplateStore.getState().init(),
        ])

        // 应用启动时同步主题设置
        const theme = useSettingsStore.getState().settings.ui.theme
        resolveAndApplyTheme(theme)

        // 应用启动时同步实时汇率（后台拉取；失败/离线保留默认值，不阻塞启动）
        void syncExchangeRate()

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
      } catch {
        // 静默处理错误
      }
    }
    // 不阻塞渲染：init 在后台执行，组件自行管理 loading 状态
    init()
  }, [])

  // ── 订阅更新检查推送（启动时静默检查完成后主进程会推送一次） ──
  useEffect(() => {
    // 先拉一次缓存（主进程可能已经完成静默检查并写入缓存）
    window.electronAPI?.updaterGetStatus?.().then((result) => {
      if (result) useUpdaterStore.getState().setResult(result)
    })
    // 订阅后续推送
    const unsubscribe = window.electronAPI?.onUpdaterStatusChanged?.((result) => {
      useUpdaterStore.getState().setResult(result)
    })
    return () => unsubscribe?.()
  }, [])

  // ── 订阅插件版本状态推送（启动时后台版本检测完成后主进程会推送一次） ──
  // ALSO actively pull from main process cache as fallback (push may fire before ipcRenderer listener is registered)
  useEffect(() => {
    // Passive listener (push)
    const unsubscribe = window.electronAPI?.plugin?.onPluginStatusUpdate?.((data: any) => {
      if (data && typeof data === 'object') {
        usePluginUpdateStore.getState().setVersionMeta(data)
      }
    })
    // Active pull (fallback — pulls from main process cache, no git fetch)
    usePluginUpdateStore.getState().refreshFromCache()
    return () => unsubscribe?.()
  }, [])

  // ── 自动弹出更新通知：发现新版本 → 弹窗（受 ignored / alreadyNoticed 保护） ──
  const updateResult = useUpdaterStore((s) => s.result)
  const updateIgnored = useUpdaterStore((s) => s.ignored)
  const updateAlreadyNoticed = useUpdaterStore((s) => s.alreadyNoticed)

  useEffect(() => {
    if (
      updateResult?.status === 'update-available' &&
      !updateIgnored &&
      !updateAlreadyNoticed
    ) {
      useUpdaterStore.getState().markShownOnce()
      useMenuBarStore.getState().openDialog('update-notice')
    }
  }, [updateResult, updateIgnored, updateAlreadyNoticed])

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

  // ── 订阅 settings-changed 广播：设置窗口保存背景图/遮罩/模糊等设置后主窗口刷新 settingsStore ──
  // loadSettings 内部会刷新 settings（含 ui.background）并 resolveAndApplyTheme：
  // 背景 effect（依赖 background 各字段）随之重跑应用新背景；主题若未变则同值 bail-out 无副作用。
  // 与上方 'settings-updated'（agent 工具路径）订阅并存，互不替代。
  useEffect(() => {
    const cleanup = window.electronAPI?.onSettingsChanged?.(() => {
      void useSettingsStore.getState().loadSettings()
    })

    return () => {
      cleanup?.()
    }
  }, [])

  // ── 订阅主进程 theme-changed 广播：设置窗口/主窗口 setWindowTheme 广播回来后刷新 themeStore ──
  // 说明：设置窗口/主窗口 setWindowTheme 广播 theme-changed 回来后，主窗口经此订阅刷新 themeStore
  // （useEffect([theme]) 会自动 applyThemeClass + setWindowTheme，setWindowTheme 重发广播幂等无害；
  // 同值 set 后 React 对相同快照 bail-out，useEffect 不重跑，无回环）。
  // 注意：此处仅刷新 themeStore，settingsStore.ui.theme 保持原值；后续 settings-updated/重启会自愈。
  useEffect(() => {
    const cleanup = window.electronAPI?.onThemeChanged?.((theme: string) => {
      resolveAndApplyTheme(theme)
    })

    return () => {
      cleanup?.()
    }
  }, [])

  // ── 模型方案变更推送：其他窗口（独立配置窗口）改了 model-schemes → 主窗口重新 hydration ──
  useEffect(() => {
    const cleanup = window.electronAPI?.onModelSchemesChanged?.(() => {
      void useModelSchemeStore.persist.rehydrate()
    })

    return () => {
      cleanup?.()
    }
  }, [])

  // ── 模型配置变更推送：其他窗口（llm-config）改了 providers/models → 主窗口重新 hydration ──
  useEffect(() => {
    const cleanup = window.electronAPI?.onLlmConfigChanged?.(() => {
      void useLLMStore.persist.rehydrate()
    })

    return () => {
      cleanup?.()
    }
  }, [])

  // ── 工具列表变更推送：其他窗口（tools）改了启用/超时 → 主窗口重新加载 ──
  useEffect(() => {
    const cleanup = window.electronAPI?.onToolsChanged?.(() => {
      void useToolStore.getState().loadTools()
    })

    return () => {
      cleanup?.()
    }
  }, [])

  // ── 提示词方案变更推送：其他窗口（prompt-config）改了 prompt-schemes → 主窗口重新 hydration ──
  useEffect(() => {
    const cleanup = window.electronAPI?.onPromptSchemesChanged?.(() => {
      void usePromptSchemeStore.persist.rehydrate()
    })

    return () => {
      cleanup?.()
    }
  }, [])

  // ── 监听 agent 工具创建的子会话事件（实时刷新侧栏） ──
  useEffect(() => {
    const cleanup = window.electronAPI?.receive?.('child_conv_created', (data: any) => {
      if (!data?.id) return
      // 委托 store action：内部保留其他工作区条目（防止 workspaces 被整体覆盖导致项目选择器丢项目）
      useConversationStore.getState().handleChildConvCreated(data.id, data.title || '子 Agent', data.parentConvId)
    })

    return () => {
      cleanup?.()
    }
  }, [])

  // ── 监听会话移交工具创建的新会话事件（刷新侧栏 + 自动切换） ──
  useEffect(() => {
    const cleanup = window.electronAPI?.receive?.('session_created', (payload: any) => {
      if (!payload?.id) return
      useConversationStore.getState().handleSessionCreated(payload.id, payload.title, payload.workspacePath || '', payload.handoffFromConvId)
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

  // ── dev-only：内存水位监控（spec §3.1，泄漏诊断基础设施）──
  useEffect(() => {
    if (!import.meta.env.DEV) return
    registerStoreMemorySources()
    startWatermarkTimer()
  }, [])

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

  // ── 窗口尺寸变化：布局过渡禁用（修复最小化恢复后三列溢出） ──
  // 场景：长任务最小化 → 恢复瞬间主线程忙于消化积压事件，transition-all 动画帧丢失，
  // 布局宽度停在中间态（消息列表/右侧栏溢出不可见），且不再补帧。
  // 方案：resize / window-maximized-changed（主进程 window.ts 已推送）触发时，
  // 临时给 window-container 挂 .layout-settling（CSS 中 transition: none !important），
  // 下一帧强制布局直接跳到终值后移除。不修改任何布局类名/结构。
  useEffect(() => {
    const root = document.querySelector('.window-container') as HTMLElement | null
    if (!root) return
    let timer: number | null = null

    const settleLayout = () => {
      if (timer) clearTimeout(timer)
      root.classList.add('layout-settling')
      // 强制同步 reflow，确保布局立即以终值计算（跳过过渡中间态）
      void root.offsetHeight
      timer = window.setTimeout(() => {
        root.classList.remove('layout-settling')
        timer = null
      }, 0)
    }

    const onMaximizedChange = () => {
      // 最大化/还原切换后布局尺寸变化，跳过过渡动画
      settleLayout()
    }
    const onResize = () => settleLayout()

    window.addEventListener('resize', onResize)
    const unsub = window.electronAPI?.onWindowMaximizedChange?.(onMaximizedChange)
    return () => {
      window.removeEventListener('resize', onResize)
      if (unsub) unsub()
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <ErrorBoundary>
      {/* Tooltip Portal（全平台挂载）：拦截 [title] 渲染主题化 tooltip，
          突破 overflow: hidden 祖先容器裁剪；Windows 上默认 Chromium 原生
          title tooltip 为白条黑字，不符合设计语言，需一并覆盖。 */}
      {typeof document !== 'undefined' && <TooltipPortal />}
      <div className="window-container relative z-10">
        {/* 本地图片背景层 + 遮罩层：必须在 window-container 内部！
            backdrop-filter 只能采样同一 stacking context 中绘制在其后的内容，
            若背景层在 window-container 外（不同 context），滚动容器/卡片 blur 会失效。 */}
        {background?.enabled && background.imagePath && (
          <>
            <div
              className="absolute inset-0 z-0 pointer-events-none"
              data-name="background-layer"
              style={{backgroundImage: `url(${background.imagePath})`, backgroundSize: 'cover', backgroundPosition: 'center'}}
            />
            <div
              className="absolute inset-0 z-0 pointer-events-none"
              style={{backgroundColor: `rgba(0, 0, 0, ${(background.overlay ?? 40) / 100})`}}
            />
          </>
        )}
        <TitleBar />
        <MenuBar />
        <main className="flex-1 flex overflow-hidden px-2 py-2 gap-2"
              style={{minHeight: 0, marginTop: 0, marginBottom: 0}}>
          {/* 左侧边栏卡片 - 折叠时隐藏 */}
          {!leftCollapsed && (
            <div
              className="app-surface-card bg-[var(--surface)] rounded-lg shadow-card border border-[var(--border)] overflow-hidden flex flex-col transition-all"
              data-name="left-sidebar-card"
              style={{width: 'var(--sidebar-width)'}}>
              <ConversationSidebar/>
            </div>
          )}
          {/* 中间主内容卡片 */}
          <div
            className="app-surface-card flex-1 flex flex-col min-w-0 transition-all overflow-hidden"
            data-name="main-column">
            <MainWorkspace/>
          </div>
        </main>
        <AnimatePresence>
          <MenuDialogRenderer key="menu-dialog" />
          <DiffModal key="diff-modal" />
          <AskUserModal key="ask-user-modal"/>
          <ConfirmDialog key="confirm-dialog"/>
          <UsageStatsDialog key="usage-stats-dialog"/>
          <PermissionConfirmModal key="permission-confirm-modal"/>
          <CompactToolPopup key="compact-tool-popup"/>
          <CombinedCardPopup key="combined-card-popup"/>
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  )
}

// ── 闲置期自动 GC（仅限 electron 渲染进程 + expose-gc 启用时）──
// 门控逻辑（隐藏期间不 GC / 恢复后宽限期）已提取到 lib/gcScheduler.ts，可单测。
if (typeof window !== 'undefined' && typeof (window as any).gc === 'function' && 'requestIdleCallback' in window) {
    createGcScheduler({
        isHidden: () => typeof document !== 'undefined' && document.hidden,
        now: () => Date.now(),
        requestIdle: (cb: (didTimeout: boolean) => void, _timeout: number) => {
            ;(window as any).requestIdleCallback(cb, {timeout: _timeout})
            return true
        },
        runGc: () => (window as any).gc(),
        onVisible: (cb: () => void) => {
            if (typeof document === 'undefined') return () => {}
            const handler = () => { if (document.visibilityState === 'visible') cb() }
            document.addEventListener('visibilitychange', handler)
            return () => document.removeEventListener('visibilitychange', handler)
        },
        scheduleInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
        scheduleTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    })
}
