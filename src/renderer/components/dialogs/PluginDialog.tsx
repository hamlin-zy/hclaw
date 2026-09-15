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
 *
 * 改造要点（B 阶段平移，对齐 CommandsDialog 试点）：
 *   - 插件列表 / 真实计数 / 能力详情 / 版本下拉 数据下沉 pluginStore，组件只留 UI 态
 *   - 启停不再跨 store 直写 skill/agent（A 阶段已由 powerManager.refresh 广播 capability:changed）
 *   - 接入 useCapabilityRefresh，能力变更后自动重取列表
 *   - 折叠统一走 common/CollapsibleSection（分类区只在内部保留「预览 N 条」差异）
 *   - 三态复用 AsyncBoundary + EmptyState；卡片骨架复用 CapabilityCard
 */

import React, {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Switch} from '../common/Switch'
import {CopyButton} from '../common/CopyButton'
import {StatusBadge} from '../common/StatusBadge'
import {UpdateDot} from '../common/UpdateDot'
import {AsyncBoundary} from '../common/AsyncBoundary'
import {CapabilityCard} from '../common/CapabilityCard'
import CollapsibleSection from '../common/CollapsibleSection'
import LinkContextMenu from '../common/LinkContextMenu'
import {usePluginStore} from '../../stores/pluginStore'
import {usePluginUpdateStore} from '../../stores/pluginUpdateStore'
import {useSettingsStore} from '../../stores/settingsStore'
import {useCapabilityRefresh} from '../../hooks/useCapabilityRefresh'
import {confirm} from '../ConfirmDialog'
import ThemedSelect from '../ThemedSelect'

const GIT_SOURCES = ['github', 'gitee', 'gitlab']
const CATEGORY_PREVIEW_LIMIT = 3

// 可折叠类别子组件：折叠骨架复用 common/CollapsibleSection，
// 仅保留「预览 N 条 + 展开全部」这一层业务差异（共享件不支持 limit，未扩其接口）。
interface CategorySectionProps {
    title: string
    icon: React.ReactNode
    items: unknown[]
    limit: number
    /** 受控展开态（整块），由父级按 pluginName:category 记忆 */
    expanded: boolean
    onToggleExpanded: (expanded: boolean) => void
    renderItem: (item: unknown, index: number) => React.ReactNode
}

function CategorySection({title, icon, items, limit, expanded, onToggleExpanded, renderItem}: CategorySectionProps) {
    const [previewExpanded, setPreviewExpanded] = useState(false)
    const needsPreview = items.length > limit
    const displayItems = needsPreview && !previewExpanded ? items.slice(0, limit) : items

    return (
        <CollapsibleSection
            title={title}
            defaultExpanded={expanded}
            onToggle={onToggleExpanded}
            headerContent={
                <span className="flex items-center gap-1 text-[var(--text-muted)]">
                    {icon}
                    <span>({items.length})</span>
                </span>
            }
        >
            <div className="space-y-2 pl-2">
                {displayItems.map(renderItem)}
                {needsPreview && !previewExpanded && (
                    <button
                        onClick={() => setPreviewExpanded(true)}
                        className="text-xs text-[var(--brand-primary)] hover:text-[color-mix(in_srgb,var(--brand-primary)_80%,transparent)] transition-colors"
                        data-name="plugin-dialog-expand-category-button">
                        展开全部（还有 {items.length - limit} 项未显示）
                    </button>
                )}
                {needsPreview && previewExpanded && (
                    <button
                        onClick={() => setPreviewExpanded(false)}
                        className="text-xs text-[var(--brand-primary)] hover:text-[color-mix(in_srgb,var(--brand-primary)_80%,transparent)] transition-colors"
                        data-name="plugin-dialog-collapse-category-button">
                        收起
                    </button>
                )}
            </div>
        </CollapsibleSection>
    )
}

export default function PluginDialog() {
    // ── 插件数据（store） ──
    const plugins = usePluginStore(s => s.plugins)
    const loading = usePluginStore(s => s.loading)
    const error = usePluginStore(s => s.error)
    const realCounts = usePluginStore(s => s.realCounts)
    const capabilityDetails = usePluginStore(s => s.capabilityDetails)
    const versionData = usePluginStore(s => s.versionData)
    const loadPlugins = usePluginStore(s => s.loadPlugins)
    const loadCapabilityDetails = usePluginStore(s => s.loadCapabilityDetails)
    const loadVersionInfo = usePluginStore(s => s.loadVersionInfo)
    const syncVersions = usePluginStore(s => s.syncVersions)
    const switchVersion = usePluginStore(s => s.switchVersion)
    const installPlugin = usePluginStore(s => s.installPlugin)
    const uninstallPlugin = usePluginStore(s => s.uninstallPlugin)
    const togglePlugin = usePluginStore(s => s.togglePlugin)
    const reloadPlugins = usePluginStore(s => s.reloadPlugins)
    const resetPlugin = usePluginStore(s => s.resetPlugin)

    // ── 纯 UI / 动作瞬时态 ──
    const [installUrl, setInstallUrl] = useState('')
    const [installing, setInstalling] = useState(false)
    const [installError, setInstallError] = useState<string | null>(null)
    const [installSuccess, setInstallSuccess] = useState<string | null>(null)
    // Track which plugin is currently being toggled (enable/disable)
    const [togglingPlugin, setTogglingPlugin] = useState<string | null>(null)
    // Track which plugin is currently being reset
    const [resettingPlugin, setResettingPlugin] = useState<string | null>(null)
    // Track update/reset result messages (per-plugin)
    const [updateResult, setUpdateResult] = useState<{name: string; message: string; isError: boolean} | null>(null)
    const updateResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // 卸载兜底：清理「更新结果」自动消失定时器
    useEffect(() => () => { if (updateResultTimer.current) clearTimeout(updateResultTimer.current) }, [])
    // Track collapsed state for each category in each plugin, key: "pluginName:category"
    const [categoryCollapsed, setCategoryCollapsed] = useState<Record<string, boolean>>({})
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

  // 挂载即拉取 + capability:changed 后自动重取（A 阶段广播口径）
  useCapabilityRefresh(loadPlugins)

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
    for (const p of plugins) {
      if (GIT_SOURCES.includes(p.source) && !versionData[p.name]) {
        void loadVersionInfo(p.name, p.manifest.version)
      }
    }
  }, [loading, plugins, versionData, loadVersionInfo])

  const handleInstall = async () => {
    if (!installUrl.trim()) return

    setInstalling(true)
    setInstallError(null)
    setInstallSuccess(null)

    const result = await installPlugin(installUrl)
    if (result.success) {
      setInstallSuccess(`插件安装成功！`)
      setInstallUrl('')
    } else {
      setInstallError(result.error)
    }
    setInstalling(false)
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

    const result = await uninstallPlugin(name)
    if (!result.success) {
        await confirm({
            title: '卸载失败',
            message: result.error,
            confirmText: '确定',
            confirmVariant: 'danger',
            onConfirm: async () => {},
        })
    }
  }

  const handleToggle = async (name: string, enabled: boolean) => {
    setTogglingPlugin(name)
    try {
        const result = await togglePlugin(name, enabled)
        // 主进程已广播 capability:changed，其它页自行刷新；此处仅报错本页动作失败
        if (!result.success) {
            await confirm({
                title: '操作失败',
                message: result.error,
                confirmText: '确定',
                confirmVariant: 'danger',
                onConfirm: async () => {},
            })
        }
    } finally {
        setTogglingPlugin(null)
    }
  }

  const handleReload = async () => {
    await reloadPlugins()
  }

  /** Show result message, auto-dismiss after 5s */
  const showUpdateMessage = (name: string, message: string, isError: boolean) => {
    setUpdateResult({name, message, isError})
    if (updateResultTimer.current) clearTimeout(updateResultTimer.current)
    updateResultTimer.current = setTimeout(() => {
      updateResultTimer.current = null
      setUpdateResult(prev => prev?.name === name ? null : prev)
    }, 5000)
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
      const result = await resetPlugin(name)
      if (result.success) {
        showUpdateMessage(name, '还原成功（本地修改已丢弃）', false)
      } else {
        showUpdateMessage(name, `还原失败: ${result.error}`, true)
      }
    } finally {
      setResettingPlugin(null)
    }
  }
  /** 「同步版本」按钮 — 只 fetch tags，不切换版本 */
  const handleSyncVersions = async (name: string) => {
    setSyncingVersion(name)
    try {
      const result = await syncVersions(name)
      if (result.success) {
        // 更新红点状态
        if (result.versionInfo?.hasUpdate) {
          usePluginUpdateStore.getState().setPluginUpdates({
            ...pluginUpdateMap,
            [name]: true,
          })
        }
        showUpdateMessage(name, '版本列表已同步', false)
      } else {
        showUpdateMessage(name, result.error || '同步失败', true)
      }
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
      const result = await switchVersion(name, targetRef)
      if (result.success) {
        showUpdateMessage(name, `版本已切换至 ${targetRef}`, false)
        // 更新红点
        if (result.versionInfo) {
          usePluginUpdateStore.getState().setPluginUpdates({
            ...pluginUpdateMap,
            [name]: result.versionInfo.hasUpdate ?? false,
          })
        }
      } else {
        showUpdateMessage(name, `切换失败: ${result.error}`, true)
      }
    } finally {
      setSwitchingVersion(null)
    }
  }

    const setCategoryExpanded = (pluginName: string, category: string, expanded: boolean) => {
        const key = `${pluginName}:${category}`
        setCategoryCollapsed(prev => ({...prev, [key]: !expanded}))
    }

    const isCategoryCollapsed = (pluginName: string, category: string) => {
        const key = `${pluginName}:${category}`
        return categoryCollapsed[key] === true // 默认展开：首屏展示前 N 条预览，折叠由用户显式触发
    }

  return (
      <div className="flex flex-col h-full">
          {/* Toolbar */}
              {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
              {/* Install Section */}
              <div className="mb-6">
                  <div className="mb-3 p-3 bg-[color-mix(in_srgb,var(--info)_10%,transparent)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-secondary)]">
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
                       focus:outline-none focus:border-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)] focus:ring-1 focus:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] transition-all"
                      data-name="plugin-dialog-input"/>
                      <button
                          onClick={handleInstall}
                          disabled={installing || !installUrl.trim()}
                          className="px-4 py-2.5 border border-[var(--border)] text-[var(--brand-primary)] hover:border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]
                       disabled:opacity-50 disabled:cursor-not-allowed
                       font-medium rounded-lg transition-colors flex items-center gap-2 text-xs"
                       data-name="plugin-dialog-install-button">
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
                       data-name="plugin-dialog-reload-button">
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

                  <AsyncBoundary
                      loading={loading}
                      error={error}
                      onRetry={() => void loadPlugins()}
                      empty={plugins.length === 0}
                      emptyTitle="暂无已安装插件"
                      emptyHint="在上方输入仓库地址安装插件。"
                      loadingText="加载插件列表..."
                  >
                      <div className="space-y-3">
                          {plugins.map(plugin => (
                              <CapabilityCard
                                  key={plugin.name}
                                  title={(() => {
                                      const repoUrl = plugin.manifest.repository || plugin.manifest.homepage
                                      return (
                                          <span
                                              className={repoUrl ? 'cursor-pointer text-[var(--brand-primary)] hover:underline' : undefined}
                                              onClick={(e) => handlePluginNameClick(repoUrl, e)}
                                              title={repoUrl || undefined}
                                              data-name="plugin-dialog-h4">
                                              {plugin.manifest.name || plugin.name}
                                          </span>
                                      )
                                  })()}
                                  badges={
                                      <>
                                          <CopyButton name={plugin.manifest.name || plugin.name} size="sm" />
                                          {plugin.manifest.version && (
                                              <span className="relative inline-flex items-center"
                                                   onClickCapture={() => {
                                                       // Lazy-load version data on first click
                                                       if (!versionData[plugin.name]) {
                                                           void loadVersionInfo(plugin.name, plugin.manifest.version)
                                                       }
                                                   }}
                                              >
                                                <ThemedSelect
                                                  value={versionData[plugin.name]?.current || plugin.manifest.version || ''}
                                                  onChange={(v) => handleVersionSwitch(plugin.name, v)}
                                                  disabled={switchingVersion === plugin.name}
                                                  ariaLabel="插件版本"
                                                  options={(() => {
                                                      const vd = versionData[plugin.name]
                                                      const sel = vd?.current || plugin.manifest.version || ''
                                                      const allOpts = [...(vd?.tags || []), ...(vd?.branches || [])]
                                                      const selInList = allOpts.includes(sel)
                                                      return [
                                                          // 当前版本不在 tag/branch 列表中时，兜底显示
                                                          ...(selInList ? [] : [{value: sel, label: sel || ''}]),
                                                          ...(vd?.tags || []).map(t => ({value: t, label: t})),
                                                          ...(vd?.branches || []).map(b => ({value: b, label: b})),
                                                      ]
                                                  })()}
                                                />
                                                {/* 更新红点 */}
                                                <span className="absolute -top-1 -right-1">
                                                    <UpdateDot show={!!pluginUpdateMap[plugin.name]} title="有新版本可用"/>
                                                </span>
                                              </span>
                                          )}
                                          {!plugin.enabled && <StatusBadge enabled={false}/>}
                                      </>
                                  }
                                  actions={
                                      <>
                                          <Switch
                                              checked={plugin.enabled}
                                              onChange={() => handleToggle(plugin.name, !plugin.enabled)}
                                              disabled={togglingPlugin !== null}
                                              loading={togglingPlugin === plugin.name}
                                          />
                                          {GIT_SOURCES.includes(plugin.source) && (
                                              <button
                                                  onClick={() => handleSyncVersions(plugin.name)}
                                                  disabled={syncingVersion !== null}
                                                  className="px-1.5 py-1.5 text-xs font-medium rounded-md
                                                     bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]
                                                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                               data-name="plugin-dialog-sync-versions-button">
                                                  {syncingVersion === plugin.name ? '同步中...' : '同步版本'}
                                              </button>
                                          )}
                                          {GIT_SOURCES.includes(plugin.source) && (
                                              <button
                                                  onClick={() => handleReset(plugin.name)}
                                                  disabled={resettingPlugin !== null}
                                                  className="px-1.5 py-1.5 text-xs font-medium rounded-md
                                                     bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)] hover:bg-[color-mix(in_srgb,var(--warning)_20%,transparent)]
                                                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                               data-name="plugin-dialog-reset-plugin-button">
                                                  {resettingPlugin === plugin.name ? '还原中...' : '还原'}
                                              </button>
                                          )}
                                          <button
                                              onClick={() => handleUninstall(plugin.name)}
                                              className="px-1.5 py-1.5 text-xs font-medium rounded-md
                                 bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_20%,transparent)]
                                 transition-colors"
                                           data-name="plugin-dialog-uninstall-button">
                                              卸载
                                          </button>
                                      </>
                                  }
                                  description={
                                      <>
                                          {plugin.manifest.description && (
                                              <p className="line-clamp-2">{plugin.manifest.description}</p>
                                          )}
                                          {plugin.manifest.author && (
                                              <p className="mt-1">by {plugin.manifest.author.name}</p>
                                          )}
                                          <span className="mt-2 flex flex-wrap gap-2">
                                      {plugin.commands && plugin.commands.length > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)] rounded">
                            {plugin.commands.length} 命令
                          </span>
                                      )}
                                      {/* Real counts from authoritative registries (one scan), NOT from PluginLoader's simplified parsing */}
                                      {(realCounts[plugin.name]?.skills ?? plugin.skills?.length ?? 0) > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] rounded">
                            {realCounts[plugin.name]?.skills ?? plugin.skills?.length ?? 0} 技能
                          </span>
                                      )}
                                      {(realCounts[plugin.name]?.agents ?? 0) > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info)] rounded">
                            {realCounts[plugin.name]?.agents ?? 0} Agent
                          </span>
                                      )}
                                      {(realCounts[plugin.name]?.mcps ?? plugin.mcpServers?.length ?? 0) > 0 && (
                                          <span
                                              className="text-xs px-2 py-0.5 bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)] rounded">
                            {realCounts[plugin.name]?.mcps ?? plugin.mcpServers?.length ?? 0} MCP
                          </span>
                                      )}
                                      <span
                                          className="text-xs px-2 py-0.5 bg-[var(--surface)] text-[var(--text-secondary)] rounded">
                          {plugin.source}
                        </span>
                                          </span>
                                      </>
                                  }
                              >
                                  {/* Update Result Message */}
                                  {updateResult?.name === plugin.name && (
                                      <div className={`mb-2 text-xs ${updateResult.isError ? 'text-[var(--error)]' : 'text-[var(--success)]'}`}>
                                          {updateResult.message}
                                      </div>
                                  )}

                                  {/* Expanded Details Section — 展开时懒加载权威注册表明细 */}
                                  <CollapsibleSection
                                      title="查看详情"
                                      defaultExpanded={false}
                                      ariaLabel={`${plugin.manifest.name || plugin.name} 详情`}
                                      onToggle={(expanded) => {
                                          if (expanded) void loadCapabilityDetails(plugin.name)
                                      }}
                                  >
                                      <div className="pt-2 space-y-4">
                                          {/* Commands */}
                                          {plugin.commands && plugin.commands.length > 0 && (
                                              <CategorySection
                                                  title="命令"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                                  </svg>}
                                                  items={plugin.commands}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  expanded={!isCategoryCollapsed(plugin.name, 'commands')}
                                                  onToggleExpanded={(expanded) => setCategoryExpanded(plugin.name, 'commands', expanded)}
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
                                                                  <p className="mt-0.5 text-xs text-[var(--text-secondary)] ml-0 line-clamp-2">
                                                                      {cmd.description.length > 120 ? cmd.description.slice(0, 120) + '…' : cmd.description}
                                                                  </p>
                                                              )}
                                                              {cmd.args && cmd.args.length > 0 && (
                                                                  <div className="mt-1 flex flex-wrap gap-1 ml-0">
                                                                      {cmd.args.map((arg, i) => (
                                                                          <span key={i}
                                                                                className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-secondary)]">
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
                                              <CategorySection
                                                  title="技能"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
                                                  </svg>}
                                                  items={skills}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  expanded={!isCategoryCollapsed(plugin.name, 'skills')}
                                                  onToggleExpanded={(expanded) => setCategoryExpanded(plugin.name, 'skills', expanded)}
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
                                                                          className="text-xs px-1.5 py-0.5 bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] rounded">
                                      可调用
                                    </span>
                                                                  )}
                                                              </div>
                                                              {skill.description && (
                                                                  <p className="mt-0.5 text-xs text-[var(--text-secondary)] line-clamp-2">
                                                                      {skill.description.length > 120 ? skill.description.slice(0, 120) + '…' : skill.description}
                                                                  </p>
                                                              )}
                                                              {skill.allowedTools && skill.allowedTools.length > 0 && (
                                                                  <div className="mt-1 flex flex-wrap gap-1">
                                                                      <span
                                                                          className="text-xs text-[var(--text-secondary)]">允许工具:</span>
                                                                      {skill.allowedTools.map((tool, j) => (
                                                                          <span key={j}
                                                                                className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-secondary)]">
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
                                              <CategorySection
                                                  title="Agent"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
                                                  </svg>}
                                                  items={agents}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  expanded={!isCategoryCollapsed(plugin.name, 'agents')}
                                                  onToggleExpanded={(expanded) => setCategoryExpanded(plugin.name, 'agents', expanded)}
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
                                                                          className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-secondary)]">
                                      {agent.type}
                                    </span>
                                                                  )}
                                                              </div>
                                                              {agent.description && (
                                                                  <p className="mt-0.5 text-xs text-[var(--text-secondary)] line-clamp-2">
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
                                              <CategorySection
                                                  title="MCP 服务器"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"/>
                                                  </svg>}
                                                  items={mcps}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  expanded={!isCategoryCollapsed(plugin.name, 'mcpServers')}
                                                  onToggleExpanded={(expanded) => setCategoryExpanded(plugin.name, 'mcpServers', expanded)}
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
                                                                                className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-secondary)] font-mono">
                                        {arg}
                                      </span>
                                                                      ))}
                                                                  </div>
                                                              )}
                                                              {server.env && Object.keys(server.env).length > 0 && (
                                                                  <div className="mt-1">
                                                                      <span
                                                                          className="text-xs text-[var(--text-secondary)]">环境变量:</span>
                                                                      <div className="flex flex-wrap gap-1 mt-0.5">
                                                                          {Object.entries(server.env).map(([key, val], j) => (
                                                                              <span key={j}
                                                                                    className="text-xs px-1.5 py-0.5 bg-[var(--surface-muted)] rounded text-[var(--text-secondary)] font-mono">
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
                                              <CategorySection
                                                  title="用户配置"
                                                  icon={<svg className="w-3 h-3" fill="none" stroke="currentColor"
                                                             strokeWidth="2" viewBox="0 0 24 24">
                                                      <path
                                                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                                                      <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                                  </svg>}
                                                  items={Object.entries(plugin.manifest.userConfig)}
                                                  limit={CATEGORY_PREVIEW_LIMIT}
                                                  expanded={!isCategoryCollapsed(plugin.name, 'userConfig')}
                                                  onToggleExpanded={(expanded) => setCategoryExpanded(plugin.name, 'userConfig', expanded)}
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
                                                                      className="text-xs text-[var(--text-secondary)]">({config.type})</span>
                                                                  {config.required && (
                                                                      <span
                                                                          className="text-xs px-1.5 py-0.5 bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)] rounded">
                                      必填
                                    </span>
                                                                  )}
                                                              </div>
                                                              {config.title && (
                                                                  <p className="mt-0.5 text-xs font-medium text-[var(--text-primary)] ml-0">{config.title}</p>
                                                              )}
                                                              {config.description && (
                                                                  <p className="mt-0.5 text-xs text-[var(--text-secondary)] ml-0">{config.description}</p>
                                                              )}
                                                          </div>
                                                      )
                                                  }}
                                              />
                                          )}

                                          {/* Source Path */}
                                          <div className="pt-2 border-t border-[var(--border-muted)]">
                                              <p className="text-xs text-[var(--text-secondary)] font-mono truncate"
                                                 title={plugin.path}>
                                                  {plugin.path}
                                              </p>
                                          </div>
                                      </div>
                                  </CollapsibleSection>
                              </CapabilityCard>
                          ))}
                      </div>
                  </AsyncBoundary>
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