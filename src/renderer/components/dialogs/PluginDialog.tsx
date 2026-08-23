/**
 * PluginDialog - 插件管理内容组件
 *
 * 提供可视化的插件管理界面：
 * - 显示已安装插件列表
 * - 通过 GitHub URL 安装新插件
 * - 启用/禁用插件
 * - 卸载插件
 *
 * 注意：此组件作为 MenuDialog 的内容渲染，不包含遮罩或弹窗逻辑
 */

import React, {useCallback, useEffect, useState} from 'react'
import {createPortal} from 'react-dom'
import {Switch} from '../common/Switch'
import {CopyButton} from '../common/CopyButton'
import LinkContextMenu from '../common/LinkContextMenu'
import {useSkillStore} from '../../stores/skillStore'
import {useAgentTemplateStore} from '../../stores/agentTemplateStore'
import {usePluginUpdateStore} from '../../stores/pluginUpdateStore'
import {useSettingsStore} from '../../stores/settingsStore'
import {confirm} from '../ConfirmDialog'

// 可折叠类别子组件
interface CollapsibleCategoryProps {
    title: string
    icon: React.ReactNode
    items: unknown[]
    limit: number
    isCollapsed: boolean
    onToggle: () => void
    renderItem: (item: unknown, index: number) => React.ReactNode
}

function CollapsibleCategory({title, icon, items, limit, isCollapsed, onToggle, renderItem}: CollapsibleCategoryProps) {
    const needsCollapse = items.length > limit
    const displayItems = needsCollapse && isCollapsed ? items.slice(0, limit) : items

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <h5 className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-1">
                    {icon}
                    {title}
                    <span className="text-[var(--text-muted)]">({items.length})</span>
                </h5>
                {needsCollapse && (
                    <button
                        onClick={onToggle}
                        className="text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary)]/80 transition-colors"
                    >
                        {isCollapsed ? `展开全部` : '收起'}
                    </button>
                )}
            </div>
            <div className="space-y-2 pl-2">
                {displayItems.map((item, i) => renderItem(item, i))}
                {needsCollapse && isCollapsed && (
                    <p className="text-xs text-[var(--text-muted)] text-center py-1">
                        还有 {items.length - limit} 项未显示
                    </p>
                )}
            </div>
        </div>
    )
}

// Plugin type (mirrored from main process)
interface PluginManifest {
  name: string
  version?: string
  description?: string
  author?: { name: string; email?: string }
  repository?: string
  homepage?: string
    userConfig?: Record<string, {
        type: 'string' | 'number' | 'boolean'
        title?: string
        description?: string
        required?: boolean
        sensitive?: boolean
        default?: unknown
        min?: number
        max?: number
    }>
}

// Extended interface with full capability details
interface PluginCapabilityDetails {
    commands?: Array<{
        id: string
        name: string
        description?: string
        args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
    }>
    skills?: Array<{
        name: string
        description: string
        allowedTools?: string[]
        userInvocable?: boolean
    }>
    agents?: Array<{
        name: string
        description: string
        type?: string
    }>
    mcpServers?: Array<{
        command: string
        args?: string[]
        env?: Record<string, string>
    }>
    userConfig?: Record<string, {
        type: string
        title?: string
        description?: string
        required?: boolean
    }>
}

interface LoadedPlugin extends PluginCapabilityDetails {
  name: string
  source: string
  path: string
  manifest: PluginManifest
  enabled: boolean
  isBuiltin: boolean
}

export default function PluginDialog() {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [installUrl, setInstallUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installSuccess, setInstallSuccess] = useState<string | null>(null)
    const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null)
    // Track which plugin is currently being toggled (enable/disable)
    const [togglingPlugin, setTogglingPlugin] = useState<string | null>(null)
    // Track which plugin is currently being reset
    const [resettingPlugin, setResettingPlugin] = useState<string | null>(null)
    // Track update/reset result messages (per-plugin)
    const [updateResult, setUpdateResult] = useState<{name: string; message: string; isError: boolean} | null>(null)
    // Track collapsed state for each category in each plugin, key: "pluginName:category"
    const [categoryCollapsed, setCategoryCollapsed] = useState<Record<string, boolean>>({})
    // Real capability counts from authoritative registries (skillRegistry/agentRegistry/mcpService),
    // overriding PluginLoader's simplified scan which may miss skills/agents in non-standard paths.
    const [realCounts, setRealCounts] = useState<Record<string, { skills: number; agents: number; mcps: number }>>({})
    // Real capability details for expanded view (fetched from authoritative registries on demand)
    const [capabilityDetails, setCapabilityDetails] = useState<Record<string, {
        skills: Array<{ name: string; description?: string; userInvocable?: boolean; allowedTools?: string[] }>
        agents: Array<{ name: string; description?: string; type?: string }>
        mcps: Array<{ command: string; args?: string[]; env?: Record<string, string> }>
    }>>({})
    const CATEGORY_PREVIEW_LIMIT = 3

    // ── 版本管理状态 ──
    const [versionData, setVersionData] = useState<Record<string, {
        tags: string[]
        branches: string[]
        current: string
        latest: string
        loading: boolean
    }>>({})
    const [syncingVersion, setSyncingVersion] = useState<string | null>(null)
    const [switchingVersion, setSwitchingVersion] = useState<string | null>(null)
    const pluginUpdateMap = usePluginUpdateStore(s => s.updateMap)
    const {settings} = useSettingsStore()
    const linkMode = settings.linkOpening?.mode ?? 'ask'
    const [linkMenu, setLinkMenu] = useState<{visible: boolean; x: number; y: number; url: string}>({
        visible: false, x: 0, y: 0, url: ''
    })

    /** 点击插件名 — 根据链接打开模式决定行为 */
    const handlePluginNameClick = (url: string | undefined, e: React.MouseEvent) => {
        if (!url) return
        if (linkMode === 'builtin') {
            window.electronAPI?.openBuiltin?.(url)
        } else if (linkMode === 'system') {
            window.electronAPI?.openSystem?.(url)
        } else {
            // ask 模式：弹出内置/系统浏览器选择菜单
            const rect = e.currentTarget.getBoundingClientRect()
            setLinkMenu({visible: true, x: rect.left + rect.width / 2, y: rect.bottom, url})
        }
    }

  /** Fetch version info for a plugin, populating the version dropdown */
  const loadVersionInfo = useCallback(async (name: string) => {
    try {
      const api = window.electronAPI as any
      const versions = await api?.plugin?.getVersions?.(name)
      if (versions) {
        setVersionData(prev => ({
          ...prev,
          [name]: {...versions, loading: false},
        }))
      }
    } catch {
      // Silently ignore — version dropdown just won't show
    }
  }, [])

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true)
      const api = window.electronAPI as any
      const list = await api?.plugin?.list()
      setPlugins(list || [])
        // Fetch real capability counts from authoritative registries (single IPC call)
        const counts = await api?.plugin?.getRealCounts?.()
        setRealCounts(counts || {})
    } catch {
        // Error silently ignored
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  // ── 订阅插件版本状态推送（独立窗口打开即同步红点，运行中接收跨窗口广播） ──
  useEffect(() => {
    // Passive listener (push from main process broadcast)
    const unsubscribe = window.electronAPI?.plugin?.onPluginStatusUpdate?.((data: any) => {
      if (data && typeof data === 'object') {
        usePluginUpdateStore.getState().setVersionMeta(data)
      }
    })
    // Active pull (fallback — pulls from main process cache, no git fetch)
    usePluginUpdateStore.getState().refreshFromCache()
    return () => unsubscribe?.()
  }, [])

  // 页面加载完成后，并行预加载所有 git 源插件的版本数据
  // 使下拉框默认值始终使用当前 tag 名称而非 manifest.version
  useEffect(() => {
    if (loading) return
    const gitSources: string[] = ['github', 'gitee', 'gitlab']
    const gitPlugins = plugins.filter(p => gitSources.includes(p.source))
    for (const p of gitPlugins) {
      loadVersionInfo(p.name)
    }
  }, [loading, plugins, loadVersionInfo])

  const handleInstall = async () => {
    if (!installUrl.trim()) return

    setInstalling(true)
    setInstallError(null)
    setInstallSuccess(null)

    try {
      const api = window.electronAPI as any
      const result = await api?.plugin?.install(installUrl)
      if (result?.success) {
        setInstallSuccess(`插件安装成功！`)
        setInstallUrl('')
        await loadPlugins()
          // 刷新 agents 列表，让新插件的 agents 立即可用
          useAgentTemplateStore.getState().syncFromDisk()
      } else if (result?.error) {
          setInstallError(getErrorMessage(result.error))
      } else {
          setInstallError('安装失败')
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  /**
   * Extract a human-readable error message from a PluginError object.
   */
  const getErrorMessage = (error: any): string => {
    if (!error || typeof error === 'string') return String(error ?? '未知错误')
    return error.message ||
        (error.type === 'manifest-not-found' ? `Manifest not found: ${error.path}` :
            error.type === 'manifest-invalid' ? `Invalid manifest: ${error.errors?.join(', ')}` :
                error.type === 'plugin-not-found' ? `Plugin not found: ${error.name}` :
                    error.type === 'dependency-unsatisfied' ? `Missing dependencies: ${error.deps?.join(', ')}` :
                        String(error))
  }

  const handleUninstall = async (name: string) => {
    const confirmed = await confirm({
        title: '确认卸载插件',
        message: `确定要卸载插件 "${name}" 吗？`,
        confirmText: '卸载',
        cancelText: '取消',
        confirmVariant: 'danger',
        onConfirm: async () => {},
    })
    if (!confirmed) return

    try {
      const api = window.electronAPI as any
        const result = await api?.plugin?.uninstall(name)
        if (result?.success) {
            await loadPlugins()
            // 刷新 agents 列表，清理已卸载插件的 agents
            useAgentTemplateStore.getState().syncFromDisk()
        } else {
            await confirm({
                title: '卸载失败',
                message: getErrorMessage(result?.error),
                confirmText: '确定',
                confirmVariant: 'danger',
                onConfirm: async () => {},
            })
        }
    } catch (err) {
        await confirm({
            title: '卸载异常',
            message: getErrorMessage(err),
            confirmText: '确定',
            confirmVariant: 'danger',
            onConfirm: async () => {},
        })
    }
  }

  const handleToggle = async (name: string, enabled: boolean) => {
    setTogglingPlugin(name)
    try {
      const api = window.electronAPI as any
        let result: { success: boolean; error?: string; skills?: unknown[]; agents?: unknown[] }
      if (enabled) {
          result = await api?.plugin?.enable(name)
      } else {
          result = await api?.plugin?.disable(name)
      }

        // 检查操作结果
        if (result?.success) {
            // 用返回的最新 skills 和 agents 列表更新 store
            if (result.skills) {
                useSkillStore.setState({ skills: result.skills as any })
            }
            if (result.agents) {
                useAgentTemplateStore.setState({ templates: result.agents as any })
            }
            await loadPlugins()
        } else {
            await confirm({
                title: '操作失败',
                message: result?.error || '未知错误',
                confirmText: '确定',
                confirmVariant: 'danger',
                onConfirm: async () => {},
            })
        }
    } catch (err) {
        await confirm({
            title: '操作异常',
            message: err instanceof Error ? err.message : String(err),
            confirmText: '确定',
            confirmVariant: 'danger',
            onConfirm: async () => {},
        })
    } finally {
        setTogglingPlugin(null)
    }
  }

  const handleReload = async () => {
    try {
      const api = window.electronAPI as any
        const result = await api?.plugin?.reload()
        if (result?.success && result.plugins) {
            setPlugins(result.plugins)
        } else if (result?.error) {
            // Error silently
        }
    } catch {
        // Error silently ignored
    }
  }

  /** Sync skills/agents stores after update — deduplicated helper */
  const syncAfterUpdate = async (result: Record<string, unknown>) => {
    await loadPlugins()
    if (result.skills) useSkillStore.setState({ skills: result.skills as any })
    if (result.agents) useAgentTemplateStore.setState({ templates: result.agents as any })
  }

  /** Show result message, auto-dismiss after 5s */
  const showUpdateMessage = (name: string, message: string, isError: boolean) => {
    setUpdateResult({ name, message, isError })
    setTimeout(() => setUpdateResult(prev => prev?.name === name ? null : prev), 5000)
  }

  const handleReset = async (name: string) => {
    const confirmed = await confirm({
      title: '确认还原插件',
      message: `确定要还原插件 "${name}" 吗？这将丢弃所有本地修改，重置到远程仓库的原始状态。`,
      confirmText: '确定还原',
      cancelText: '取消',
      confirmVariant: 'danger',
    })
    if (!confirmed) return

    setResettingPlugin(name)
    setUpdateResult(null)
    try {
      const api = window.electronAPI as any
      const result = await api?.plugin?.reset(name)

      if (result?.success) {
        showUpdateMessage(name, '还原成功（本地修改已丢弃）', false)
        await syncAfterUpdate(result)
      } else {
        const errorMsg = result?.error?.message || result?.error?.type || '未知错误'
        showUpdateMessage(name, `还原失败: ${errorMsg}`, true)
      }
    } catch (err) {
      showUpdateMessage(name, `还原异常: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      setResettingPlugin(null)
    }
  }

  /** 「同步版本」按钮 — 只 fetch tags，不切换版本 */
  const handleSyncVersions = async (name: string) => {
    setSyncingVersion(name)
    try {
      const api = window.electronAPI as any
      const result = await api?.plugin?.syncVersions?.(name)
      if (result?.versionInfo) {
        setVersionData(prev => ({
          ...prev,
          [name]: {...result.versionInfo, loading: false},
        }))
        // 更新红点状态
        if (result.versionInfo.hasUpdate) {
          usePluginUpdateStore.getState().setPluginUpdates({
            ...pluginUpdateMap,
            [name]: true,
          })
        }
        showUpdateMessage(name, '版本列表已同步', false)
      } else {
        showUpdateMessage(name, '同步失败', true)
      }
    } catch (err) {
      showUpdateMessage(name, `同步异常: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      setSyncingVersion(null)
    }
  }

  /** 版本切换 — 弹窗确认 → git checkout → powerManager.refresh */
  const handleVersionSwitch = async (name: string, targetRef: string) => {
    const currentRef = versionData[name]?.current || ''
    const confirmed = await confirm({
      title: '确认切换版本',
      message: `确定将插件 "${name}" 的版本从 "${currentRef}" 切换为 "${targetRef}"？\n\n该操作会重新加载插件的所有能力。`,
      confirmText: '确定切换',
      cancelText: '取消',
      confirmVariant: 'warning',
    })
    if (!confirmed) return

    setSwitchingVersion(name)
    try {
      const api = window.electronAPI as any
      const result = await api?.plugin?.switchVersion?.(name, targetRef)
      if (result?.success) {
        showUpdateMessage(name, `版本已切换至 ${targetRef}`, false)
        // 更新下拉状态
        if (result.versionInfo) {
          setVersionData(prev => ({
            ...prev,
            [name]: {...result.versionInfo, loading: false},
          }))
          // 更新红点
          usePluginUpdateStore.getState().setPluginUpdates({
            ...pluginUpdateMap,
            [name]: result.versionInfo.hasUpdate,
          })
        }
        // 刷新插件列表和 agent 列表
        await loadPlugins()
        useAgentTemplateStore.getState().syncFromDisk()
      } else {
        showUpdateMessage(name, `切换失败: ${result?.error || '未知错误'}`, true)
      }
    } catch (err) {
      showUpdateMessage(name, `切换异常: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      setSwitchingVersion(null)
    }
  }

    const toggleCategory = (pluginName: string, category: string) => {
        const key = `${pluginName}:${category}`
        setCategoryCollapsed(prev => ({...prev, [key]: !prev[key]}))
    }

    const isCategoryCollapsed = (pluginName: string, category: string) => {
        const key = `${pluginName}:${category}`
        return categoryCollapsed[key] !== false // default collapsed
    }

  return (
      <div className="flex flex-col h-full">
          {/* Toolbar */}
              {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
              {/* Install Section */}
              <div className="mb-6">
                  <div className="mb-3 p-3 bg-[var(--info)]/10 border border-[var(--border)] rounded-lg text-xs text-[var(--text-secondary)]">
                      安装和更新插件需要系统已安装 <strong>Git</strong>。
                      支持 GitHub、Gitee、GitLab 等公开仓库地址。
                  </div>
                  <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">安装插件</h3>
                  <div className="flex gap-2">
                      <input
                          type="text"
                          value={installUrl}
                          onChange={e => setInstallUrl(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleInstall()}
                          placeholder="输入仓库地址，如 https://github.com/obra/superpowers 或 https://gitee.com/user/repo"
                          className="flex-1 px-4 py-2.5 bg-[var(--surface-muted)] rounded-lg border border-[var(--border)]
                       text-[var(--text-primary)] placeholder-[var(--text-muted)]
                       focus:outline-none focus:border-[var(--brand-primary)]/50 focus:ring-1 focus:ring-[var(--brand-primary)]/30 transition-all"
                      />
                      <button
                          onClick={handleInstall}
                          disabled={installing || !installUrl.trim()}
                          className="px-4 py-2.5 border border-[var(--border)] text-[var(--brand-primary)] hover:border-[var(--brand-primary)]/50 hover:bg-[var(--brand-primary)]/10
                       disabled:opacity-50 disabled:cursor-not-allowed
                       font-medium rounded-lg transition-colors flex items-center gap-2 text-xs"
                      >
                          {installing && (
                              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                              </svg>
                          )}
                          {installing ? '安装中...' : '安装'}
                      </button>
                      <button
                          onClick={handleReload}
                          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded transition-colors"
                          title="刷新"
                      >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path d="M23 4v6h-6M1 20v-6h6"/>
                              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                          </svg>
                      </button>
                  </div>
                  {installError && (
                      <div className="mt-2 text-sm text-[var(--error)]">{installError}</div>
                  )}
                  {installSuccess && (
                      <div className="mt-2 text-sm text-[var(--success)]">{installSuccess}</div>
                  )}
              </div>

              {/* Plugin List */}
              <div>
                  <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">已安装插件</h3>

                  {loading ? (
                      <div className="flex items-center justify-center py-8">
                          <div
                              className="w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                      </div>
                  ) : plugins.length === 0 ? (
                      <div className="py-8 text-center text-[var(--text-muted)]">
                          暂无已安装插件
                      </div>
                  ) : (
                      <div className="space-y-3">
                          {plugins.map(plugin => (
                              <div
                                  key={plugin.name}
                                  className="p-4 bg-[var(--surface-muted)] rounded-lg border border-[var(--border)]"
                              >
                                  {/* Title Row: name + version + disabled badge | three buttons */}
                                  <div className="flex items-center justify-between gap-4">
                                      <div className="flex items-center gap-1 min-w-0">
                                            {(() => {
                                                const repoUrl = plugin.manifest.repository || plugin.manifest.homepage
                                                const nameClass = repoUrl
                                                    ? 'text-[var(--brand-primary)] hover:underline cursor-pointer'
                                                    : 'text-[var(--text-primary)]'
                                                return (
                                                    <h4
                                                        className={`font-medium truncate ${nameClass}`}
                                                        onClick={(e) => handlePluginNameClick(repoUrl, e)}
                                                        title={repoUrl || undefined}
                                                    >
                                                        {plugin.manifest.name || plugin.name}
                                                    </h4>
                                                )
                                            })()}
                                          <CopyButton name={plugin.manifest.name || plugin.name} size="sm" />
                                          {plugin.manifest.version && (
                                              <div className="relative inline-flex items-center">
                                                <select
                                                  value={versionData[plugin.name]?.current || plugin.manifest.version || ''}
                                                  onChange={(e) => handleVersionSwitch(plugin.name, e.target.value)}
                                                  disabled={switchingVersion === plugin.name}
                                                  className="text-xs px-1.5 py-0.5 bg-[var(--surface)] rounded
                                                    text-[var(--text-muted)] border border-[var(--border-muted)]
                                                    focus:outline-none focus:border-[var(--brand-primary)]/50
                                                    disabled:opacity-50 disabled:cursor-not-allowed max-w-[120px]"
                                                  onClick={() => {
                                                    // Lazy-load version data on first click
                                                    if (!versionData[plugin.name]) {
                                                      setVersionData(prev => ({...prev, [plugin.name]: {tags: [], branches: [], current: plugin.manifest.version || '', latest: '', loading: true}}))
                                                      loadVersionInfo(plugin.name)
                                                    }
                                                  }}
                                                >
                                                  {(() => {
                                                    const vd = versionData[plugin.name]
                                                    const sel = vd?.current || plugin.manifest.version || ''
                                                    const allOpts = [...(vd?.tags || []), ...(vd?.branches || [])]
                                                    const selInList = allOpts.includes(sel)
                                                    return <>
                                                      {/* 当前版本不在 tag/branch 列表中时，兜底显示 */}
                                                      {!selInList && (
                                                        <option value={sel}>{sel || ''}</option>
                                                      )}
                                                      {vd?.tags?.map(t => (
                                                        <option key={`tag-${t}`} value={t}>{t}</option>
                                                      ))}
                                                      {vd?.branches?.map(b => (
                                                        <option key={`branch-${b}`} value={b}>{b}</option>
                                                      ))}
                                                    </>
                                                  })()}
                                                </select>
                                                {/* 更新红点 */}
                                                {pluginUpdateMap[plugin.name] && (
                                                  <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-red-500" />
                                                )}
                                              </div>
                                          )}
                                          {!plugin.enabled && (
                                              <span
                                                  className="text-xs text-[var(--warning)] px-1.5 py-0.5 bg-[var(--warning)]/10 rounded">
                            已禁用
                          </span>
                                          )}
                                      </div>
                                      <div className="flex items-center gap-0 flex-shrink-0">
                                          <Switch
                                              checked={plugin.enabled}
                                              onChange={() => handleToggle(plugin.name, !plugin.enabled)}
                                              disabled={togglingPlugin !== null}
                                              loading={togglingPlugin === plugin.name}
                                          />
                                          {['github', 'gitee', 'gitlab'].includes(plugin.source) && (
                                              <button
                                                  onClick={() => handleSyncVersions(plugin.name)}
                                                  disabled={syncingVersion !== null}
                                                  className="px-1.5 py-1.5 text-xs font-medium rounded-md
                                                     bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20
                                                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                              >
                                                  {syncingVersion === plugin.name ? '同步中...' : '同步版本'}
                                              </button>
                                          )}
                                          {['github', 'gitee', 'gitlab'].includes(plugin.source) && (
                                              <button
                                                  onClick={() => handleReset(plugin.name)}
                                                  disabled={resettingPlugin !== null}
                                                  className="px-1.5 py-1.5 text-xs font-medium rounded-md
                                                     bg-[var(--warning)]/10 text-[var(--warning)] hover:bg-[var(--warning)]/20
                                                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                              >
                                                  {resettingPlugin === plugin.name ? '还原中...' : '还原'}
                                              </button>
                                          )}
                                          <button
                                              onClick={() => handleUninstall(plugin.name)}
                                              className="px-1.5 py-1.5 text-xs font-medium rounded-md
                                 bg-[var(--error)]/10 text-[var(--error)] hover:bg-[var(--error)]/20
                                 transition-colors"
                                          >
                                              卸载
                                          </button>
                                      </div>
                                  </div>
                                  {/* Info Section — full width below title row */}
                                  {plugin.manifest.description && (
                                      <p className="mt-2 text-sm text-[var(--text-muted)] line-clamp-2">
                                          {plugin.manifest.description}
                                      </p>
                                  )}
                                  {plugin.manifest.author && (
                                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                                          by {plugin.manifest.author.name}
                                      </p>
                                  )}
                                  <div className="mt-2 flex flex-wrap gap-2">
                                      {plugin.commands && plugin.commands.length > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] rounded">
                            {plugin.commands.length} 命令
                          </span>
                                      )}
                                      {/* Real counts from authoritative registries (one scan), NOT from PluginLoader's simplified parsing */}
                                      {(realCounts[plugin.name]?.skills ?? plugin.skills?.length ?? 0) > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[var(--success)]/10 text-[var(--success)] rounded">
                            {realCounts[plugin.name]?.skills ?? plugin.skills?.length ?? 0} 技能
                          </span>
                                      )}
                                      {(realCounts[plugin.name]?.agents ?? 0) > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[var(--info)]/10 text-[var(--info)] rounded">
                            {realCounts[plugin.name]?.agents ?? 0} Agent
                          </span>
                                      )}
                                      {(realCounts[plugin.name]?.mcps ?? plugin.mcpServers?.length ?? 0) > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[var(--warning)]/10 text-[var(--warning)] rounded">
                            {realCounts[plugin.name]?.mcps ?? plugin.mcpServers?.length ?? 0} MCP
                          </span>
                                      )}
                                      <span
                                          className="text-xs px-2 py-0.5 bg-[var(--surface)] text-[var(--text-muted)] rounded">
                          {plugin.source}
                        </span>
                                  </div>
                                  {/* Expand/Collapse Button */}
                                  <button
                                      onClick={async () => {
                                          if (expandedPlugin === plugin.name) {
                                              setExpandedPlugin(null)
                                          } else {
                                              setExpandedPlugin(plugin.name)
                                              // Fetch real capability details from authoritative registries
                                              if (!capabilityDetails[plugin.name]) {
                                                  try {
                                                      const api = window.electronAPI as any
                                                      const details = await api?.plugin?.getCapabilityDetails?.(plugin.name)
                                                      if (details) {
                                                          setCapabilityDetails(prev => ({...prev, [plugin.name]: details}))
                                                      }
                                                  } catch { /* ignore */ }
                                              }
                                          }
                                      }}
                                      className="mt-3 flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                                  >
                                      <svg
                                          className={`w-3 h-3 transition-transform ${expandedPlugin === plugin.name ? 'rotate-180' : ''}`}
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          viewBox="0 0 24 24"
                                      >
                                          <path d="M19 9l-7 7-7-7"/>
                                      </svg>
                                      {expandedPlugin === plugin.name ? '收起详情' : '查看详情'}
                                  </button>
                                  {/* Update Result Message */}
                                  {updateResult?.name === plugin.name && (
                                      <div className={`mt-2 mb-1 text-xs ${updateResult.isError ? 'text-[var(--error)]' : 'text-[var(--success)]'}`}>
                                          {updateResult.message}
                                      </div>
                                  )}

                                  {/* Expanded Details Section */}
                                  {expandedPlugin === plugin.name && (
                                      <div className="mt-4 pt-4 border-t border-[var(--border)] space-y-4">
                                          {/* Commands */}
                                          {plugin.commands && plugin.commands.length > 0 && (
                                              <CollapsibleCategory
                                                  title="命令"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                                  </svg>}
                                                  items={plugin.commands}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  isCollapsed={isCategoryCollapsed(plugin.name, 'commands')}
                                                  onToggle={() => toggleCategory(plugin.name, 'commands')}
                                                  renderItem={(item: unknown) => {
                                                      const cmd = item as typeof plugin.commands[0]
                                                      return (
                                                          <div key={cmd.id} className="text-sm">
                                                              <div className="flex items-center gap-2">
                                                                  <code
                                                                      className="text-xs px-1.5 py-0.5 bg-[var(--surface)] rounded text-[var(--brand-primary)]">
                                                                      {cmd.id}
                                                                  </code>
                                                                  <span
                                                                      className="font-medium text-[var(--text-primary)]">{cmd.name}</span>
                                                                  <CopyButton name={cmd.name} size="sm" />
                                                              </div>
                                                              {cmd.description && (
                                                                  <p className="mt-0.5 text-xs text-[var(--text-muted)] ml-0 line-clamp-2">
                                                                      {cmd.description.length > 120 ? cmd.description.slice(0, 120) + '…' : cmd.description}
                                                                  </p>
                                                              )}
                                                              {cmd.args && cmd.args.length > 0 && (
                                                                  <div className="mt-1 flex flex-wrap gap-1 ml-0">
                                                                      {cmd.args.map((arg, i) => (
                                                                          <span key={i}
                                                                                className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-muted)]">
                                        {arg.required ? '*' : ''}{arg.name}
                                                                              {arg.description && `: ${arg.description}`}
                                      </span>
                                                                      ))}
                                                                  </div>
                                                              )}
                                                          </div>
                                                      )
                                                  }}
                                              />
                                          )}

                                          {/* Skills (from authoritative registry) */}
                                          {(() => {
                                            const skills = capabilityDetails[plugin.name]?.skills || plugin.skills || []
                                            if (skills.length === 0) return null
                                            return (
                                              <CollapsibleCategory
                                                  title="技能"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
                                                  </svg>}
                                                  items={skills}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  isCollapsed={isCategoryCollapsed(plugin.name, 'skills')}
                                                  onToggle={() => toggleCategory(plugin.name, 'skills')}
                                                  renderItem={(item: unknown) => {
                                                      const skill = item as { name: string; description?: string; userInvocable?: boolean; allowedTools?: string[] }
                                                      return (
                                                          <div key={skill.name} className="text-sm">
                                                              <div className="flex items-center gap-2">
                                                                  <span
                                                                      className="font-medium text-[var(--text-primary)]">{skill.name}</span>
                                                                  <CopyButton name={skill.name} size="sm" />
                                                                  {skill.userInvocable && (
                                                                      <span
                                                                          className="text-xs px-1.5 py-0.5 bg-[var(--success)]/10 text-[var(--success)] rounded">
                                      可调用
                                    </span>
                                                                  )}
                                                              </div>
                                                              {skill.description && (
                                                                  <p className="mt-0.5 text-xs text-[var(--text-muted)] line-clamp-2">
                                                                      {skill.description.length > 120 ? skill.description.slice(0, 120) + '…' : skill.description}
                                                                  </p>
                                                              )}
                                                              {skill.allowedTools && skill.allowedTools.length > 0 && (
                                                                  <div className="mt-1 flex flex-wrap gap-1">
                                                                      <span
                                                                          className="text-xs text-[var(--text-muted)]">允许工具:</span>
                                                                      {skill.allowedTools.map((tool, j) => (
                                                                          <span key={j}
                                                                                className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-muted)]">
                                        {tool}
                                      </span>
                                                                      ))}
                                                                  </div>
                                                              )}
                                                          </div>
                                                      )
                                                  }}
                                              />
                                            )
                                          })()}
                                          {/* Agents (from authoritative registry) */}
                                          {(() => {
                                            const agents = capabilityDetails[plugin.name]?.agents || plugin.agents || []
                                            if (agents.length === 0) return null
                                            return (
                                              <CollapsibleCategory
                                                  title="Agent"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
                                                  </svg>}
                                                  items={agents}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  isCollapsed={isCategoryCollapsed(plugin.name, 'agents')}
                                                  onToggle={() => toggleCategory(plugin.name, 'agents')}
                                                  renderItem={(item: unknown) => {
                                                      const agent = item as { name: string; description?: string; type?: string }
                                                      return (
                                                          <div key={agent.name} className="text-sm">
                                                              <div className="flex items-center gap-2">
                                                                  <span
                                                                      className="font-medium text-[var(--text-primary)]">{agent.name}</span>
                                                                  <CopyButton name={agent.name} size="sm" />
                                                                  {agent.type && (
                                                                      <span
                                                                          className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-muted)]">
                                      {agent.type}
                                    </span>
                                                                  )}
                                                              </div>
                                                              {agent.description && (
                                                                  <p className="mt-0.5 text-xs text-[var(--text-muted)] line-clamp-2">
                                                                      {agent.description.length > 120 ? agent.description.slice(0, 120) + '…' : agent.description}
                                                                  </p>
                                                              )}
                                                          </div>
                                                      )
                                                  }}
                                              />
                                          )
                                          })()}
                                          {/* MCP Servers (from authoritative registry) */}
                                          {(() => {
                                            const mcps = capabilityDetails[plugin.name]?.mcps || plugin.mcpServers || []
                                            if (mcps.length === 0) return null
                                            return (
                                              <CollapsibleCategory
                                                  title="MCP 服务器"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"/>
                                                  </svg>}
                                                  items={mcps}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  isCollapsed={isCategoryCollapsed(plugin.name, 'mcpServers')}
                                                  onToggle={() => toggleCategory(plugin.name, 'mcpServers')}
                                                  renderItem={(item: unknown) => {
                                                      const server = item as { command: string; args?: string[]; env?: Record<string, string> }
                                                      return (
                                                          <div key={server.command} className="text-sm">
                                                              <code
                                                                  className="text-xs px-1.5 py-0.5 bg-[var(--surface)] rounded text-[var(--text-secondary)] font-mono">
                                                                  {server.command}
                                                              </code>
                                                              {server.args && server.args.length > 0 && (
                                                                  <div className="mt-1 flex flex-wrap gap-1 ml-0">
                                                                      {server.args.map((arg, j) => (
                                                                          <span key={j}
                                                                                className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-muted)] font-mono">
                                        {arg}
                                      </span>
                                                                      ))}
                                                                  </div>
                                                              )}
                                                              {server.env && Object.keys(server.env).length > 0 && (
                                                                  <div className="mt-1">
                                                                      <span
                                                                          className="text-xs text-[var(--text-muted)]">环境变量:</span>
                                                                      <div className="flex flex-wrap gap-1 mt-0.5">
                                                                          {Object.entries(server.env).map(([key, val], j) => (
                                                                              <span key={j}
                                                                                    className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-muted)] font-mono">
                                          {key}={val}
                                        </span>
                                                                          ))}
                                                                      </div>
                                                                  </div>
                                                              )}
                                                          </div>
                                                      )
                                                  }}
                                              />
                                          )
                                          })()}
                                          {/* User Config */}
                                          {plugin.manifest.userConfig && Object.keys(plugin.manifest.userConfig).length > 0 && (
                                              <CollapsibleCategory
                                                  title="用户配置"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                                                      <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                                  </svg>}
                                                  items={Object.entries(plugin.manifest.userConfig)}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  isCollapsed={isCategoryCollapsed(plugin.name, 'userConfig')}
                                                  onToggle={() => toggleCategory(plugin.name, 'userConfig')}
                                                  renderItem={(item: unknown) => {
                                                      const [key, config] = item as [string, typeof plugin.manifest.userConfig[string]]
                                                      return (
                                                          <div key={key} className="text-sm">
                                                              <div className="flex items-center gap-2">
                                                                  <code
                                                                      className="text-xs px-1.5 py-0.5 bg-[var(--surface)] rounded text-[var(--text-secondary)]">
                                                                      {key}
                                                                  </code>
                                                                  <span
                                                                      className="text-xs text-[var(--text-muted)]">({config.type})</span>
                                                                  {config.required && (
                                                                      <span
                                                                          className="text-xs px-1.5 py-0.5 bg-[var(--error)]/10 text-[var(--error)] rounded">
                                      必填
                                    </span>
                                                                  )}
                                                              </div>
                                                              {config.title && (
                                                                  <p className="mt-0.5 text-xs font-medium text-[var(--text-primary)] ml-0">{config.title}</p>
                                                              )}
                                                              {config.description && (
                                                                  <p className="mt-0.5 text-xs text-[var(--text-muted)] ml-0">{config.description}</p>
                                                              )}
                                                          </div>
                                                      )
                                                  }}
                                              />
                                          )}

                                          {/* Source Path */}
                                          <div className="pt-2 border-t border-[var(--border)]">
                                              <p className="text-xs text-[var(--text-muted)] font-mono truncate"
                                                 title={plugin.path}>
                                                  {plugin.path}
                                              </p>
                                          </div>
                                      </div>
                                  )}
                              </div>
                          ))}
                      </div>
                  )}
              </div>
          </div>
          {/* LinkContextMenu for 'ask' mode — 点击插件名跳转仓库 */}
          {createPortal(
              <LinkContextMenu
                  visible={linkMenu.visible}
                  x={linkMenu.x}
                  y={linkMenu.y}
                  url={linkMenu.url}
                  onClose={() => setLinkMenu(prev => ({...prev, visible: false}))}
              />,
              document.body
          )}
      </div>
  )
}