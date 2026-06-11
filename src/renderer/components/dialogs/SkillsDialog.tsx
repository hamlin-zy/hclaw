import {useCallback, useEffect, useMemo, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useSkillStore} from '../../stores/skillStore'
import {fuzzyFilter} from '../../lib/search'
import {confirm} from '../../components/ConfirmDialog'
import LoadErrorBanner from '../common/LoadErrorBanner'
import {CopyButton} from '../common/CopyButton'
import SkillDetailModal from './SkillDetailModal'
import {Folder, Search, Trash2, ChevronDown, Check, AlertCircle, Plus, Download, RefreshCw} from 'lucide-react'

type TabType = 'local' | 'plugin'

export default function SkillsDialog() {
    const {
        skills,
        toggleSkill,
        toggleSkillBatch,
        matchedSkills,
        refreshSkills,
        loadSkills,
        installSkill,
        removeSkill,
        loadErrors,
        initialized,
    } = useSkillStore()
    const [activeTab, setActiveTab] = useState<TabType>('local')
    const [searchQuery, setSearchQuery] = useState('')
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
    const [refreshing, setRefreshing] = useState(false)
    const [installing, setInstalling] = useState(false)
    const [installMessage, setInstallMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
    const openSkillDetail = useCallback((skill: import('@shared/types').Skill, mode: 'preview' | 'edit' = 'preview') => {
        setDetailModal({isOpen: true, skill, mode})
    }, [])

    const openCreateSkill = useCallback(() => {
        setDetailModal({isOpen: true, skill: null, mode: 'create'})
    }, [])

    const closeDetailModal = useCallback(() => {
        setDetailModal({isOpen: false, skill: null, mode: 'preview'})
    }, [])

    // 打开时自动加载技能列表
    const [dataLoading, setDataLoading] = useState(false)
    useEffect(() => {
        if (!initialized) {
            setDataLoading(true)
            loadSkills().finally(() => setDataLoading(false))
        }
    }, [initialized, loadSkills])

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
        } else if (result.error && result.error !== 'User cancelled') {
            setInstallMessage({type: 'error', text: `安装失败: ${result.error}`})
        }
        // 3秒后自动清除提示
        setTimeout(() => setInstallMessage(null), 3000)
    }, [installSkill])

    const filteredSkills = useMemo(() => {
        let filtered = skills

        // 按标签过滤
        if (activeTab === 'local') {
            filtered = filtered.filter(s => s.source === 'builtin' || s.source === 'user' || !s.source)
        } else if (activeTab === 'plugin') {
            filtered = filtered.filter(s => s.source === 'plugin')
        }

        // 按搜索词过滤（模糊子序列匹配，codesim → code-simplifier）
        if (searchQuery.trim()) {
            filtered = fuzzyFilter(filtered, searchQuery, ['name'])
        }

        return filtered
    }, [skills, activeTab, searchQuery])

  return (
      <div className="h-full flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Skills 管理</h3>
              <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-muted)]">{skills.length} 个技能</span>
                  <button
                      onClick={openCreateSkill}
                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[var(--success)]/10 text-[var(--success)] hover:bg-[var(--success)]/20 transition-colors"
                      title="创建新技能"
                      aria-label="创建新技能"
                  >
                      <Plus className="w-3.5 h-3.5"/>
                      <span>创建</span>
                  </button>
                  <button
                      onClick={handleInstall}
                      disabled={installing}
                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="安装技能 (ZIP)"
                      aria-label="安装技能"
                  >
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
                  >
                      <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}/>
                  </button>
              </div>
          </div>

          {/* Install message toast */}
          {installMessage && (
              <div className={`mx-4 mt-2 px-3 py-2 text-xs rounded-md flex items-center gap-2 ${
                  installMessage.type === 'success'
                      ? 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20'
                      : 'bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/20'
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
              errors={loadErrors.map(e => ({name: e.skillDir.split(/[/\\]/).pop() || '', error: e.error}))}
              title={`${loadErrors.length} 个技能加载失败`}
              tip="请检查对应 SKILL.md 文件的 YAML frontmatter 格式，修改后点击刷新按钮重试"
          />

          {/* Tabs */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--border-muted)]">
              {(['local', 'plugin'] as TabType[]).map(tab => (
                  <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                          activeTab === tab
                              ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                      }`}
                  >
                      {tab === 'local' && '本地'}
                      {tab === 'plugin' && '插件'}
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
                  />
              </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
              {dataLoading && !initialized ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                      <RefreshCw className="w-8 h-8 text-[var(--text-muted)]/20 mb-3 animate-spin"/>
                      <p className="text-sm text-[var(--text-muted)]">正在加载技能列表...</p>
                      <p className="text-xs text-[var(--text-muted)]/60 mt-1">扫描磁盘中，请稍候</p>
                  </div>
              ) : filteredSkills.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Folder className="w-10 h-10 text-[var(--text-muted)]/30 mb-3"/>
                      <p className="text-sm text-[var(--text-muted)]">暂无技能</p>
                      <p className="text-xs text-[var(--text-muted)]/60 mt-1">安装 Skills 以扩展 Agent 功能</p>
                  </div>
              ) : activeTab === 'plugin' ? (
                  <PluginGroupedList
                      skills={filteredSkills}
                      matchedSkills={matchedSkills}
                      onToggle={toggleSkill}
                      onToggleBatch={toggleSkillBatch}
                      onOpenDetail={openSkillDetail}
                  />
              ) : (
                  <div className="p-2 space-y-1.5">
                      <AnimatePresence initial={false}>
                          {filteredSkills.map(skill => (
                              <SkillCard
                                  key={skill.id}
                                  skill={skill}
                                  isMatched={matchedSkills.some(m => m.skillId === skill.id)}
                                  onToggle={() => toggleSkill(skill.id)}
                                  onOpenDetail={() => openSkillDetail(skill)}
                              />
                          ))}
                      </AnimatePresence>
                  </div>
              )}
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
                   }: {
    skill: import('@shared/types').Skill
    isMatched: boolean
    onToggle: () => void
    onOpenDetail: () => void
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
        } else {
            setDeleteError(result.error || '删除失败')
            setTimeout(() => setDeleteError(null), 4000)
        }
    }, [skill, removeSkill, refreshSkills])

    return (
        <motion.div
            layout
            initial={{opacity: 0, y: -8}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -8}}
            transition={{duration: 0.15}}
        >
            <div
                className={`rounded-xl border transition-all cursor-pointer overflow-hidden ${
                    skill.enabled
                        ? 'bg-[var(--surface)] border-[var(--border)] hover:border-[var(--border-muted)]'
                        : 'bg-[var(--surface)] border-[var(--border)] opacity-60'
                }`}
                onClick={onOpenDetail}
            >
                <div className="p-3">
                    {/* Title Row: name + badges + action buttons */}
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1 min-w-0">
                            <span className="text-sm font-semibold text-[var(--text-primary)] truncate">{skill.name}</span>
                            <CopyButton name={skill.name} />
                            {isMatched && (
                                <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse"/>
                            )}
                            {skill.source === 'builtin' && (
                                <span
                                    className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[var(--info)]/10 text-[var(--info)]">
                                        内置
                                    </span>
                            )}
                            {skill.source === 'plugin' && (
                                <span
                                    className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
                                        插件
                                    </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
                            {skill.filePath && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        window.electronAPI?.showItemInFolder?.(skill.filePath!)
                                    }}
                                    className="p-1 text-gray-300 hover:text-[var(--brand-primary)] transition-colors"
                                    title="打开所在目录"
                                >
                                    <Folder className="w-4 h-4"/>
                                </button>
                            )}
                            {skill.source === 'user' && (
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    className="p-1 text-gray-300 hover:text-[var(--error)] transition-colors disabled:opacity-30"
                                    title="删除技能"
                                >
                                    <Trash2 className="w-4 h-4"/>
                                </button>
                            )}
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onToggle()
                                }}
                                className={`w-8 h-4.5 rounded-full p-0.5 transition-colors relative ${
                                    skill.enabled ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'
                                }`}
                            >
                                <div
                                    className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${skill.enabled ? 'translate-x-3.5' : 'translate-x-0'}`}
                                />
                            </button>
                        </div>
                    </div>
                    {/* Description — full width */}
                    <p className="text-sm text-[var(--text-muted)] mt-1.5 line-clamp-2">{skill.description}</p>
                    {deleteError && (
                        <p className="text-xs text-[var(--error)] mt-1">{deleteError}</p>
                    )}
                </div>
            </div>
        </motion.div>
    )
}

// ─── Plugin Grouped List ──────────────────────────────────────────

function PluginGroupedList({
                               skills,
                               matchedSkills,
                               onToggle,
                               onToggleBatch,
                               onOpenDetail,
                           }: {
    skills: import('@shared/types').Skill[]
    matchedSkills: { skillId: string }[]
    onToggle: (id: string) => void
    onToggleBatch: (skillIds: string[], enabled: boolean) => Promise<{ success: boolean; error: string }>
    onOpenDetail: (skill: import('@shared/types').Skill, mode?: 'preview' | 'edit') => void
}) {
    // 从插件真实启用状态过滤：只有 pluginEnabled=true 的插件才显示分组
    // 注意：不能用 skill.enabled 推断，因为插件启用/禁用不会更新技能个体的 enabled（保留用户配置）
    const enabledPlugins = useMemo(() => {
        const set = new Set<string>()
        for (const skill of skills) {
            if (skill.source === 'plugin' && skill.pluginEnabled && skill.pluginName) {
                set.add(skill.pluginName)
            }
        }
        return set
    }, [skills])

    // 按插件名分组，只显示已启用插件的分组
    const grouped = useMemo(() => {
        const map = new Map<string, import('@shared/types').Skill[]>()
        for (const skill of skills) {
            const pluginName = skill.pluginName || 'unknown'
            if (!enabledPlugins.has(pluginName)) continue
            const list = map.get(pluginName) || []
            list.push(skill)
            map.set(pluginName, list)
        }
        return Array.from(map.entries()).map(([name, pluginSkills]) => ({ name, skills: pluginSkills }))
    }, [skills, enabledPlugins])

    return (
        <div className="p-2 space-y-3">
            <AnimatePresence initial={false}>
                {grouped.map(group => (
                    <PluginGroupCard
                        key={group.name}
                        pluginName={group.name}
                        skills={group.skills}
                        matchedSkills={matchedSkills}
                        onToggle={onToggle}
                        onToggleBatch={onToggleBatch}
                        onOpenDetail={onOpenDetail}
                    />
                ))}
            </AnimatePresence>
        </div>
    )
}

function PluginGroupCard({
                             pluginName,
                             skills,
                             matchedSkills,
                             onToggle,
                             onToggleBatch,
                             onOpenDetail,
                         }: {
    pluginName: string
    skills: import('@shared/types').Skill[]
    matchedSkills: { skillId: string }[]
    onToggle: (id: string) => void
    onToggleBatch: (skillIds: string[], enabled: boolean) => Promise<{ success: boolean; error: string }>
    onOpenDetail: (skill: import('@shared/types').Skill, mode?: 'preview' | 'edit') => void
}) {
    const [collapsed, setCollapsed] = useState(true)

    return (
        <motion.div
            layout
            initial={{opacity: 0, y: -8}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -8}}
            transition={{duration: 0.15}}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
        >
            {/* 插件标题栏 */}
            <div
                className="flex items-center justify-between px-3 py-2 bg-[var(--surface-muted)]/50 cursor-pointer"
                onClick={() => setCollapsed(c => !c)}
            >
                <div className="flex items-center gap-2">
                    <Folder className="w-4 h-4 text-[var(--brand-primary)]"/>
                    <span className="text-xs font-semibold text-[var(--text-primary)]">{pluginName}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">{skills.length} 个技能</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                        onClick={async e => {
                            e.stopPropagation()
                            const allEnabled = skills.every(s => s.enabled)
                            const targetEnabled = !allEnabled
                            const ids = skills.filter(s => s.enabled !== targetEnabled).map(s => s.id)
                            if (ids.length > 0) await onToggleBatch(ids, targetEnabled)
                        }}
                        className="text-[10px] font-medium text-[var(--brand-primary)] hover:text-[var(--brand-primary)]/80 transition-colors flex-shrink-0"
                    >
                        {skills.every(s => s.enabled) ? '全部禁用' : '全部启用'}
                    </button>
                    <ChevronDown
                        className={`w-4 h-4 text-[var(--text-muted)] transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}
                    />
                </div>
            </div>

            {/* 插件下的技能列表 */}
            <AnimatePresence initial={false}>
                {!collapsed && (
                    <motion.div
                        initial={{opacity: 0, height: 0}}
                        animate={{opacity: 1, height: 'auto'}}
                        exit={{opacity: 0, height: 0}}
                        transition={{duration: 0.2, ease: 'easeInOut'}}
                        style={{overflow: 'hidden'}}
                    >
                        <div className="p-2 space-y-1.5 border-t border-[var(--border-muted)]">
                            {skills.map(skill => (
                                <SkillCard
                                    key={skill.id}
                                    skill={skill}
                                    isMatched={matchedSkills.some(m => m.skillId === skill.id)}
                                    onToggle={() => onToggle(skill.id)}
                                    onOpenDetail={() => onOpenDetail(skill)}
                                />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}
