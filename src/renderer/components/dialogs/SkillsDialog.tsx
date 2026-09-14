import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {dropdown} from '../../lib/motionPresets'
import {useSkillStore} from '../../stores/skillStore'
import {toErrorMessage} from '../../stores/applyOptimistic'
import {fuzzyFilter} from '../../lib/search'
import {confirm} from '../../components/ConfirmDialog'
import LoadErrorBanner from '../common/LoadErrorBanner'
import {CopyButton} from '../common/CopyButton'
import {Switch} from '../common/Switch'
import {CapabilityCard} from '../common/CapabilityCard'
import {AsyncBoundary} from '../common/AsyncBoundary'
import {EmptyState} from '../common/EmptyState'
import {UpdateDot} from '../common/UpdateDot'
import {useCapabilityRefresh} from '../../hooks/useCapabilityRefresh'
import SkillDetailModal from './SkillDetailModal'
import RepoGroupCard from '../repo/RepoGroupCard'
import PluginGroupCard from '../common/PluginGroupCard'
import {useRepoUpdateStore} from '../../stores/repoUpdateStore'
import {buildRepoGroups, filterRepoTabSkills, sortReposByUpdate} from '../repo/repoGrouping'
import {Folder, Search, Trash2, Check, AlertCircle, Plus, Download, RefreshCw, GitBranch} from 'lucide-react'

type TabType = 'local' | 'repo' | 'plugin'

export default function SkillsDialog() {
    const {
        skills,
        toggleSkill,
        toggleSkillBatch,
        matchedSkills,
        refreshSkills,
        loadSkills,
        installSkill,
        loadErrors,
    } = useSkillStore()
    const [activeTab, setActiveTab] = useState<TabType>('local')
    const [searchQuery, setSearchQuery] = useState('')
    // 三态：loading 仅在首次加载展示；后续刷新（订阅触发）静默替换数据，避免列表卸载重建
    const [loading, setLoading] = useState(true)
    const [pageError, setPageError] = useState<string | null>(null)
    const loadedRef = useRef(false)
    // 仓库红点状态（有更新的仓库列表项置顶显示）
    const repoUpdateMap = useRepoUpdateStore(s => s.updateMap)
    const repoHasUpdate = useRepoUpdateStore(s => s.hasUpdate)
    // 弹窗状态：isOpen=是否可见, skill=当前显示的skill, mode=预览/编辑/创建
    const [detailModal, setDetailModal] = useState<{
        isOpen: boolean
        skill: import('@shared/types').Skill | null
        mode: 'preview' | 'edit' | 'create'
    }>({
        isOpen: false,
        skill: null,
        mode: 'preview'
    })
    const enabledCount = useMemo(() => skills.filter(s => s.enabled).length, [skills])
    const [refreshing, setRefreshing] = useState(false)
    const [installing, setInstalling] = useState(false)
    const [installMessage, setInstallMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
    const [repoUrl, setRepoUrl] = useState('')
    const [repoInstalling, setRepoInstalling] = useState(false)
    const [repoList, setRepoList] = useState<any[]>([])

    // 仓库列表（用于本地/插件 Tab 按仓库归属分组）
    const refreshRepoList = useCallback(() => {
        return (window.electronAPI as any)?.repo?.list?.().then((repos: any[]) => setRepoList(repos || [])).catch(() => {})
    }, [])

    // 挂载时拉取一次
    useEffect(() => {
        refreshRepoList()
    }, [refreshRepoList])

    // 打开/切换仓库 tab 时主动拉取仓库版本 meta，确保红点与置顶反映当前状态。
    // （App 启动时的仓库版本检测为异步 fire-and-forget，可能晚于本对话框渲染导致 updateMap 为空）
    useEffect(() => {
        void useRepoUpdateStore.getState().refreshFromCache()
    }, [activeTab])

    const handleRepoInstall = useCallback(async () => {
        if (!repoUrl.trim()) return
        setRepoInstalling(true)
        setInstallMessage(null)
        try {
            const api = window.electronAPI as any
            const result = await api?.repo?.install?.('skill', repoUrl.trim())
            if (result?.success) {
                setInstallMessage({type: 'success', text: `仓库已安装: ${result.repoId}`})
                await refreshSkills()
                refreshRepoList()
                setRepoUrl('')
                setTimeout(() => setInstallMessage(null), 3000)
            } else {
                // 错误消息不清除，避免用户尚未读完即消失
                setInstallMessage({type: 'error', text: `安装失败: ${result?.error || '未知错误'}`})
            }
        } catch (e: any) {
            setInstallMessage({type: 'error', text: `安装失败: ${e?.message || '未知错误'}`})
        } finally {
            setRepoInstalling(false)
        }
    }, [repoUrl, refreshSkills, refreshRepoList])
    const openSkillDetail = useCallback((skill: import('@shared/types').Skill, mode: 'preview' | 'edit' = 'preview') => {
        setDetailModal({isOpen: true, skill, mode})
    }, [])

    const openCreateSkill = useCallback(() => {
        setDetailModal({isOpen: true, skill: null, mode: 'create'})
    }, [])

    const closeDetailModal = useCallback(() => {
        setDetailModal({isOpen: false, skill: null, mode: 'preview'})
    }, [])

    // 数据加载：首屏展示 loading；刷新 / capability:changed 订阅触发时静默替换数据
    const loadData = useCallback(async () => {
        if (!loadedRef.current) setLoading(true)
        try {
            await loadSkills()
            setPageError(null)
        } catch (err) {
            setPageError(toErrorMessage(err))
        } finally {
            loadedRef.current = true
            setLoading(false)
        }
    }, [loadSkills])

    // 挂载即拉取 + 订阅 capability:changed 自动重取
    useCapabilityRefresh(loadData, [])

    const handleRefresh = useCallback(async () => {
        setRefreshing(true)
        await refreshSkills()
        setRefreshing(false)
    }, [refreshSkills])

    const handleInstall = useCallback(async () => {
        setInstalling(true)
        setInstallMessage(null)
        const result = await installSkill()
        setInstalling(false)
        if (result.success) {
            setInstallMessage({type: 'success', text: `技能 "${result.skillName}" 安装成功`})
            refreshRepoList()
        } else if (result.error && result.error !== 'User cancelled') {
            setInstallMessage({type: 'error', text: `安装失败: ${result.error}`})
        }
        // 3秒后自动清除提示
        setTimeout(() => setInstallMessage(null), 3000)
    }, [installSkill, refreshRepoList])

    const filteredSkills = useMemo(() => {
        let filtered = skills

        // 按标签过滤
        if (activeTab === 'local') {
            filtered = filtered.filter(s => s.source === 'builtin' || s.source === 'user' || !s.source)
        } else if (activeTab === 'repo') {
            // 仓库 tab：只显示 skills 管理页安装的仓库（skills/public，source='user'），排除插件目录技能
            filtered = filterRepoTabSkills(filtered)
        } else if (activeTab === 'plugin') {
            filtered = filtered.filter(s => s.source === 'plugin')
        }

        // 按搜索词过滤（模糊子序列匹配，codesim → code-simplifier）
        if (searchQuery.trim()) {
            filtered = fuzzyFilter(filtered, searchQuery, ['name'])
        }

        return filtered
    }, [skills, activeTab, searchQuery])

    // 空态文案：随 tab 与搜索态变化
    const emptyTitle = searchQuery.trim()
        ? '未找到匹配的技能'
        : activeTab === 'plugin' ? '暂无插件技能' : activeTab === 'repo' ? '暂无仓库技能' : '暂无技能'
    const emptyHint = searchQuery.trim()
        ? undefined
        : activeTab === 'local' ? '安装 Skills 以扩展 Agent 功能' : undefined

  return (
      <div className="h-full flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-muted)]">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Skills 管理</h3>
              <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-secondary)]">{skills.length} 个技能 · {enabledCount} 个已启用</span>
                  <button
                      onClick={openCreateSkill}
                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] hover:bg-[color-mix(in_srgb,var(--success)_20%,transparent)] transition-colors"
                      title="创建新技能"
                      aria-label="创建新技能"
                   data-name="skills-dialog-button">
                      <Plus className="w-3.5 h-3.5"/>
                      <span>创建</span>
                  </button>
                  <button
                      onClick={handleInstall}
                      disabled={installing}
                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="安装技能 (ZIP)"
                      aria-label="安装技能"
                   data-name="skills-dialog-install-zip-button">
                      {installing ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin"/>
                      ) : (
                          <Download className="w-3.5 h-3.5"/>
                      )}
                      <span>安装</span>
                  </button>
                  <button
                      onClick={handleRefresh}
                      disabled={refreshing}
                      className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="刷新技能列表"
                      aria-label="刷新技能列表"
                   data-name="skills-dialog-refresh-button">
                      <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}/>
                  </button>
              </div>
          </div>

          {/* Repo install input */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border-muted)]">
              <GitBranch className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0"/>
              <input
                  type="text"
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !repoInstalling && handleRepoInstall()}
                  placeholder="输入 Git 仓库地址，从仓库安装技能（克隆到 skills/public 并按仓库分组）"
                  className="flex-1 px-2.5 py-1.5 text-xs bg-[var(--surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
               data-name="skills-dialog-repo-input"/>
              <button
                  onClick={handleRepoInstall}
                  disabled={repoInstalling || !repoUrl.trim()}
                  className="flex-shrink-0 px-2 py-1 text-xs font-medium rounded-md border border-[var(--border)] text-[var(--brand-primary)] hover:border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
               data-name="skills-dialog-repo-install-button">
                  {repoInstalling ? '安装中...' : '安装仓库'}
              </button>
          </div>

          {/* Install message toast */}
          {installMessage && (
              <div className={`mx-4 mt-2 px-3 py-2 text-xs rounded-md flex items-center gap-2 ${
                  installMessage.type === 'success'
                      ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] border border-[color-mix(in_srgb,var(--success)_20%,transparent)]'
                      : 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)] border border-[color-mix(in_srgb,var(--error)_20%,transparent)]'
              }`}>
                  {installMessage.type === 'success'
                      ? <Check className="w-3.5 h-3.5 flex-shrink-0"/>
                      : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0"/>
                  }
                  {installMessage.text}
              </div>
          )}

          {/* Load errors warning */}
          <LoadErrorBanner
              errors={loadErrors.map(e => ({name: (e.skillDir ? e.skillDir.split(/[/\\]/).pop() : '') || '', error: e.error}))}
              title={`${loadErrors.length} 个技能加载失败`}
              tip="请检查对应 SKILL.md 文件的 YAML frontmatter 格式，修改后点击刷新按钮重试"
          />

          {/* Tabs */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--border-muted)]">
              {(['local', 'repo', 'plugin'] as TabType[]).map((tab, i) => (
                  <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`relative px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                          activeTab === tab
                              ? 'bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)]'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                      }`}
                   data-name={`skills-dialog-tab-${i}`}>
                      {tab === 'local' && '本地'}
                      {tab === 'repo' && '仓库'}
                      {tab === 'plugin' && '插件'}
                      {/* 仓库 tab 红点：存在可升级仓库时提示 */}
                      {tab === 'repo' && repoHasUpdate && (
                          <span className="absolute top-1.5 right-1">
                              <UpdateDot show title="有可用更新"/>
                          </span>
                      )}
                  </button>
              ))}
          </div>

          {/* Search */}
          <div className="px-4 py-2 border-b border-[var(--border-muted)]">
              <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"/>
                  <input
                      type="text"
                      placeholder="搜索技能..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
                  data-name="skills-dialog-input"/>
              </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
              <AsyncBoundary
                  loading={loading}
                  error={pageError}
                  onRetry={() => void loadData()}
                  empty={filteredSkills.length === 0}
                  emptyTitle={emptyTitle}
                  emptyHint={emptyHint}
              >
                  {activeTab === 'plugin' ? (
                      <PluginGroupedList
                          skills={filteredSkills}
                          matchedSkills={matchedSkills}
                          repoList={repoList}
                          onToggle={toggleSkill}
                          onToggleBatch={toggleSkillBatch}
                          onOpenDetail={openSkillDetail}
                      />
                  ) : (
                      (() => {
                          // 按仓库归属分组：有归属进 group，无归属进 local
                          const {local: localSkills, groups} = buildRepoGroups(filteredSkills, repoList)
                          if (activeTab === 'repo') {
                              // 仓库 tab：只展示仓库分组卡片，有更新的仓库置顶
                              const sortedGroups = sortReposByUpdate(groups, repoUpdateMap)
                              return sortedGroups.length > 0 ? (
                                  <div className="p-2 space-y-3">
                                      <AnimatePresence initial={false}>
                                          {sortedGroups.map(group => (
                                              <RepoGroupCard
                                                  key={group.repo.id}
                                                  repo={group.repo}
                                                  skillCount={group.skills.length}
                                                  agentCount={0}
                                                  skills={group.skills}
                                                  onToggleBatch={toggleSkillBatch}
                                                  onVersionSwitched={() => void useSkillStore.getState().refreshSkills()}
                                              >
                                                  {group.skills.map(skill => (
                                                      <SkillCard
                                                          key={skill.id}
                                                          skill={skill}
                                                          isMatched={matchedSkills.some(m => m.skillId === skill.id)}
                                                          onToggle={() => toggleSkill(skill.id)}
                                                          onOpenDetail={() => openSkillDetail(skill)}
                                                          onDeleted={refreshRepoList}
                                                      />
                                                  ))}
                                              </RepoGroupCard>
                                          ))}
                                      </AnimatePresence>
                                  </div>
                              ) : (
                                  <EmptyState
                                      title="暂无仓库技能"
                                      hint="在上方输入 Git 仓库地址安装，技能将归入对应仓库分组"
                                      icon={<Folder className="w-10 h-10 text-[color-mix(in_srgb,var(--text-muted)_50%,transparent)]"/>}
                                  />
                              )
                          }
                          // 本地 tab：只展示无仓库归属的本地技能
                          return localSkills.length > 0 ? (
                              <div className="p-2 space-y-1.5">
                                  <AnimatePresence initial={false}>
                                      {localSkills.map(skill => (
                                          <SkillCard
                                              key={skill.id}
                                              skill={skill}
                                              isMatched={matchedSkills.some(m => m.skillId === skill.id)}
                                              onToggle={() => toggleSkill(skill.id)}
                                              onOpenDetail={() => openSkillDetail(skill)}
                                              onDeleted={refreshRepoList}
                                          />
                                      ))}
                                  </AnimatePresence>
                              </div>
                          ) : (
                              <EmptyState
                                  title="暂无本地技能"
                                  hint="本地技能已全部归入仓库分组，可在「仓库」tab 查看"
                                  icon={<Folder className="w-10 h-10 text-[color-mix(in_srgb,var(--text-muted)_50%,transparent)]"/>}
                              />
                          )
                      })()
                  )}
              </AsyncBoundary>
          </div>

          {/* Skill Detail Modal */}
          <SkillDetailModal
              isOpen={detailModal.isOpen}
              skill={detailModal.skill}
              mode={detailModal.mode}
              onClose={closeDetailModal}
              onCreateSuccess={handleRefresh}
          />
      </div>
  )
}

// ─── Skill Card ──────────────────────────────────────────

function SkillCard({
                       skill,
                       isMatched,
                       onToggle,
                       onOpenDetail,
                       onDeleted,
                   }: {
    skill: import('@shared/types').Skill
    isMatched: boolean
    onToggle: () => void
    onOpenDetail: () => void
    onDeleted?: () => void
}) {
    const {removeSkill, refreshSkills} = useSkillStore()
    const [deleting, setDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)

    const handleDelete = useCallback(async (e: React.MouseEvent) => {
        e.stopPropagation()
        if (!skill.id) return
        const confirmed = await confirm({
            title: '删除技能',
            message: `确定要删除技能「${skill.name}」吗？此操作不可撤销。`,
            confirmText: '删除',
            confirmVariant: 'danger',
        })
        if (!confirmed) return
        setDeleting(true)
        const result = await removeSkill(skill.id)
        setDeleting(false)
        if (result.success) {
            refreshSkills()
            onDeleted?.()
        } else {
            setDeleteError(result.error || '删除失败')
            setTimeout(() => setDeleteError(null), 4000)
        }
    }, [skill, removeSkill, refreshSkills, onDeleted])

    const actions = (
        <div
            className="flex items-center gap-1.5"
            onClick={e => e.stopPropagation()}
            data-name="skills-dialog-skill-actions"
        >
            {skill.filePath && (
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        window.electronAPI?.showItemInFolder?.(skill.filePath!)
                    }}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors"
                    title="打开所在目录"
                 data-name="skills-dialog-open-folder-button">
                    <Folder className="w-4 h-4"/>
                </button>
            )}
            {skill.source === 'user' && (
                <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--error)] transition-colors disabled:opacity-30"
                    title="删除技能"
                 data-name="skills-dialog-delete-button">
                    <Trash2 className="w-4 h-4"/>
                </button>
            )}
            <Switch
                checked={skill.enabled}
                onChange={() => onToggle()}
                ariaLabel={skill.enabled ? `禁用技能 ${skill.name}` : `启用技能 ${skill.name}`}
            />
        </div>
    )

    return (
        <motion.div
            layout
            {...dropdown}
            transition={{duration: 0.15}}
        >
            <div
                className={`cursor-pointer ${skill.enabled ? '' : 'opacity-60'}`}
                onClick={onOpenDetail}
             data-name="skills-dialog-div">
                <CapabilityCard
                    title={skill.name}
                    description={
                        <>
                            <span className="block line-clamp-2">{skill.description}</span>
                            {deleteError && (
                                <span className="mt-1 block text-xs text-[var(--error)]">{deleteError}</span>
                            )}
                        </>
                    }
                    badges={
                        <>
                            <CopyButton name={skill.name}/>
                            {isMatched && (
                                <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse"/>
                            )}
                            {skill.source === 'builtin' && (
                                <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info)]">
                                    内置
                                </span>
                            )}
                            {skill.source === 'plugin' && (
                                <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)]">
                                    插件
                                </span>
                            )}
                        </>
                    }
                    actions={actions}
                />
            </div>
        </motion.div>
    )
}

// ─── Plugin Grouped List ──────────────────────────────────────────

function PluginGroupedList({
                               skills,
                               matchedSkills,
                               repoList,
                               onToggle,
                               onToggleBatch,
                               onOpenDetail,
                           }: {
    skills: import('@shared/types').Skill[]
    matchedSkills: { skillId: string }[]
    repoList: any[]
    onToggle: (id: string) => void
    onToggleBatch: (skillIds: string[], enabled: boolean) => Promise<{ success: boolean; error: string }>
    onOpenDetail: (skill: import('@shared/types').Skill, mode?: 'preview' | 'edit') => void
}) {
    const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({})
    // 按 owner/repo（repoId）分组，只显示至少有 1 个 pluginEnabled 技能的仓库分组
    // 批处理「全部启用/禁用」仍基于技能个体 enabled（保留用户配置）
    const grouped = useMemo(() => {
        const map = new Map<string, {repo: any; skills: import('@shared/types').Skill[]}>()
        for (const skill of skills) {
            const repo = repoList.find(r => (r.capabilities?.skills || []).includes(skill.id))
            if (repo) {
                const entry = map.get(repo.id) || {repo, skills: []}
                entry.skills.push(skill)
                map.set(repo.id, entry)
            } else {
                // 未命中仓库归属的 plugin skill（如手动解压到插件目录）：
                // 按 pluginName 兜底分组，保证技能不静默消失
                const groupKey = `plugin:${skill.pluginName || skill.id}`
                const fallbackRepo = {
                    id: skill.pluginName || skill.id,
                    name: skill.pluginName || skill.id,
                    source: 'plugin',
                    capabilities: {skills: [], agents: [], plugins: []},
                }
                const entry = map.get(groupKey) || {repo: fallbackRepo, skills: []}
                entry.skills.push(skill)
                map.set(groupKey, entry)
            }
        }
        return Array.from(map.values()).filter(group => group.skills.some(s => s.pluginEnabled))
    }, [skills, repoList])

    return (
        <div className="p-2 space-y-3">
            <AnimatePresence initial={false}>
                {grouped.map(group => {
                    const collapsed = collapsedMap[group.repo.id] ?? true
                    const allEnabled = group.skills.every(s => s.enabled)
                    return (
                        <PluginGroupCard
                            key={group.repo.id}
                            title={group.repo.id}
                            titleExtra={<CopyButton name={group.repo.id} size="sm" />}
                            countLabel={`${group.skills.length} 个技能`}
                            collapsed={collapsed}
                            onToggleCollapse={() => setCollapsedMap(m => ({...m, [group.repo.id]: !(m[group.repo.id] ?? true)}))}
                            allEnabled={allEnabled}
                            onToggleBatch={() => {
                                const target = !allEnabled
                                const ids = group.skills.filter(s => s.enabled !== target).map(s => s.id)
                                void onToggleBatch(ids, target)
                            }}
                            headerDataName="skills-dialog-plugin-group-header"
                            batchDataName="skills-dialog-batch-toggle-button"
                        >
                            <div className="p-2 space-y-1.5 border-t border-[var(--border-muted)]">
                                {group.skills.map(skill => (
                                    <SkillCard
                                        key={skill.id}
                                        skill={skill}
                                        isMatched={matchedSkills.some(m => m.skillId === skill.id)}
                                        onToggle={() => onToggle(skill.id)}
                                        onOpenDetail={() => onOpenDetail(skill)}
                                    />
                                ))}
                            </div>
                        </PluginGroupCard>
                    )
                })}
            </AnimatePresence>
        </div>
    )
}
