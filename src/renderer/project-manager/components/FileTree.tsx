import React, {Fragment, useEffect, useMemo, useRef, useState} from 'react'
import {ChevronsDownUp, ChevronsUpDown, Crosshair, Eye, EyeOff, RefreshCw} from 'lucide-react'
import {useWorkspaceStore} from '../stores/workspaceStore'
import {useFileTreeStore} from '../stores/fileTreeStore'
import {useEditorTabStore} from '../stores/editorTabStore'
import {useGitStatusStore} from '../stores/gitStatusStore'
import {toOpenFileTabInput} from '../utils/fileOpenGate'
import type {DirEntry} from '@shared/types/project-manager'
import {PanelCard} from '../ui/PanelCard'
import {PanelHeader} from '../ui/PanelHeader'
import {TreeRow} from '../ui/TreeRow'
import {StatusBadge} from '../ui/StatusBadge'
import {IconButton} from '../ui/IconButton'
import {ContextMenu} from '../ui/ContextMenu'
import {useSendToConversation} from '../ui/SendToConversationProvider'
import {EmptyState} from '../ui/EmptyState'
import {FOLDER_OPEN_SPEC, FOLDER_SPEC, fileIcon} from '../lib/fileIcon'
import {dominantStatus, statusClassSuffix, type VcsStatus} from '../lib/statusColor'
import {absPath} from '../lib/absPath'
import {modsOf} from '../lib/multiSelect'
import {sortByVisibleOrder} from '../lib/visibleOrder'
import {confirm} from '../../components/ConfirmDialog'

// workspace 基名（跨平台：兼容 \ 与 /）
const basename = (ws: string) => ws.split(/[\\/]/).filter(Boolean).pop() || ws

/** 全部展开的目录数上限：必须 < CACHE_LIMIT(500)，否则 LRU 会淘汰已进 expanded 的目录，
 *  渲染出"看起来展开却没有子项"的假展开（spec §3.3 / §6.3） */
const EXPAND_ALL_MAX_DIRS = 400
/** 全部展开的受控并发度（避免一次打爆 IPC 与文件系统，spec §6.3） */
const EXPAND_ALL_CONCURRENCY = 4

/** 外部变更后补齐缓存的去抖时长（与 ProjectManagerApp 的外部变更防抖节奏、watcher 的 awaitWriteFinish 一致） */
const FILE_RELOAD_DEBOUNCE_MS = 500

/** 归一为 POSIX 相对路径（与 statusMap / data-path 同值域，spec §3.1） */
const normalizeEntryPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** 'a/b/c.ts' → ['.', 'a', 'a/b']（含 root，不含目标自身） */
const ancestorDirs = (p: string): string[] => {
  const parts = p.split('/').filter(Boolean)
  const dirs = ['.']
  for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'))
  return dirs
}

/** CSS.escape 兜底（jsdom 与浏览器都提供，仍做防御） */
const cssEscape = (v: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&')

interface MenuState { x: number, y: number, entry: DirEntry }

export function FileTree() {
  const ws = useWorkspaceStore(s => s.workspacePath)
  const expanded = useFileTreeStore(s => s.expanded)
  const childrenCache = useFileTreeStore(s => s.childrenCache)
  const invalidateTick = useFileTreeStore(s => s.invalidateTick)
  const setChildren = useFileTreeStore(s => s.setChildren)
  const getChildren = useFileTreeStore(s => s.getChildren)
  const setWorkspace = useFileTreeStore(s => s.setWorkspace)
  const toggleExpand = useFileTreeStore(s => s.toggleExpand)
  const select = useFileTreeStore(s => s.select)
  const selectWithMods = useFileTreeStore(s => s.selectWithMods)
  const selectedPaths = useFileTreeStore(s => s.selectedPaths)
  const sendToConversation = useSendToConversation()
  const selectedPath = useFileTreeStore(s => s.selectedPath)
  const openFileTab = useEditorTabStore(s => s.openFileTab)
  const revealTarget = useFileTreeStore(s => s.revealTarget)
  const requestReveal = useFileTreeStore(s => s.requestReveal)
  const clearReveal = useFileTreeStore(s => s.clearReveal)
  const [revealing, setRevealing] = useState(false)
  const [expandingAll, setExpandingAll] = useState(false)
  const [resolvedReveal, setResolvedReveal] = useState<{path: string} | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 当前激活 tab 的文件路径：file 与 diff tab 都携带 filePath（见 editorTabStore.openDiffTab，
  // 所有调用点都传了 filePath），diff 视图不再单独放按钮，就复用文件树头部这一个（spec §3.1）。
  // 无 tab / 空 filePath → undefined（按钮 disabled）。
  const activeFilePath = useEditorTabStore(s => {
    const t = s.tabs.find(x => x.id === s.activeTabId)
    return t?.filePath || undefined
  })
  const statusMap = useGitStatusStore(s => s.summary?.statusMap)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [rootExpanded, setRootExpanded] = useState(true)
  // 显示/隐藏被忽略文件（spec §6.3：默认显示；只影响被忽略文件，点文件始终显示）
  const [showIgnored, setShowIgnored] = useState(true)
  // 归属守卫：ws 用 ref 追踪最新值，异步回调落地前比对请求发出时的快照
  const wsRef = useRef(ws)
  wsRef.current = ws
  // 卸载守卫：卸载后禁止 setState / openFileTab
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  /** 请求发出时的 ws 快照，落地时是否仍归属当前 workspace 且组件仍挂载 */
  const isCurrent = (reqWs: string) => mountedRef.current && wsRef.current === reqWs

  // 唯一加载路径：可等待版本（reveal 需顺序等待祖先加载完成）
  const loadDirAsync = async (path: string): Promise<void> => {
    const owner = ws
    const entries = await window.electronAPI?.projectManager.listDirectory(owner, path) ?? []
    setChildren(path, entries, owner)
  }

  const loadDir = (path: string) => { void loadDirAsync(path) }

  const ensureChildren = (dir: DirEntry) => {
    if (getChildren(dir.path) !== undefined) return
    loadDir(dir.path)
  }

  const loadRoot = () => loadDir('.')

  useEffect(() => {
    // 归属切换：清理上一 workspace 的目录缓存，再加载新根目录
    setWorkspace(ws)
    if (getChildren('.') === undefined) loadRoot()
  }, [ws])

  // 外部变更（pm:file-changed）经 invalidateFrom 只清缓存、不重取；这里补齐被清掉的
  // 「根 + 已展开目录」，否则根目录被失效后整棵树渲染成空
  //（expanded ⊆ childrenCache 不变量，见 spec §3.1）。
  // 去抖：watcher 的 pm:file-changed 未去抖，批量变更（git checkout / npm i）会连续到达。
  useEffect(() => {
    if (invalidateTick === 0) return
    const ownerWs = ws
    const timer = setTimeout(() => {
      const s = useFileTreeStore.getState()
      if (!ownerWs || s.ws !== ownerWs) return   // 期间切了 workspace：交给 [ws] effect 重载
      for (const dir of ['.', ...s.expanded]) {
        if (s.childrenCache[dir] === undefined) loadDir(dir)
      }
    }, FILE_RELOAD_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [invalidateTick])

  // 阶段 1：顺序加载祖先目录 → 展开 → 选中（spec §3.1 的动作序列，顺序不可交换）
  useEffect(() => {
    if (revealTarget === null) return
    const reqWs = ws
    // 最新请求栅栏：revealTarget 的原始值。ws 在同一窗口内恒定，只有它能区分新旧请求；
    // 迟到请求发现 revealTarget 已被替代即放弃落地（由最新请求负责落地/清理）。
    const reqTarget = revealTarget
    const target = normalizeEntryPath(revealTarget)
    const dirs = ancestorDirs(target)
    setRevealing(true)
    void (async () => {
      try {
        for (const d of dirs) {
          if (getChildren(d) !== undefined) continue
          await loadDirAsync(d)
          if (!isCurrent(reqWs)) { clearReveal(); return }
          if (useFileTreeStore.getState().revealTarget !== reqTarget) return   // 已被更新的请求取代：由最新请求负责落地/清理
        }
        // 目标条目被忽略且当前被隐藏 → 先打开「显示被忽略文件」，否则渲染后查不到元素
        const entry = getChildren(dirs[dirs.length - 1]!)?.find(e => e.path === target)
        if (entry?.ignored) setShowIgnored(true)
        const next = new Set(useFileTreeStore.getState().expanded)
        for (const d of dirs.slice(1)) next.add(d)     // root 不入 expanded
        useFileTreeStore.setState({expanded: next})
        setRootExpanded(true)
        select(target)
        setResolvedReveal({path: target})
      } catch {
        // 目标不可达：静默结束（仅当仍是最新请求时才清理，避免误清新请求的 revealTarget）
        if (isCurrent(reqWs) && useFileTreeStore.getState().revealTarget === reqTarget) clearReveal()
      } finally {
        // 仅当仍是最新请求时才复位，避免旧请求提前重新启用定位按钮
        if (isCurrent(reqWs) && useFileTreeStore.getState().revealTarget === reqTarget) setRevealing(false)
      }
    })()
  }, [revealTarget, ws])

  // 阶段 2：等 React commit（DOM 就绪）后滚动到目标元素并清理 revealTarget
  useEffect(() => {
    if (!resolvedReveal) return
    const el = containerRef.current?.querySelector(`[data-path="${cssEscape(resolvedReveal.path)}"]`)
    if (el) (el as HTMLElement).scrollIntoView({block: 'nearest'})
    setResolvedReveal(null)
    clearReveal()
  }, [resolvedReveal, expanded, childrenCache])

  const collapseAll = () => {
    useFileTreeStore.setState({expanded: new Set()})
    setRootExpanded(false)
  }

  /** 递归全展：BFS 逐层加载；达到 EXPAND_ALL_MAX_DIRS 即停止继续加载（spec §3.3）
   *  加载结果先落本地、结束时一次提交：中间批次对用户不可见（expanded 结尾才写入），
   *  逐目录提交只会把同一次全展放大成上百次全树重渲（大仓下为 O(目录数²) 的渲染量） */
  const expandAll = async () => {
    const reqWs = ws
    setExpandingAll(true)
    const pending = new Map<string, DirEntry[]>()
    const readLocal = (p: string): DirEntry[] | undefined =>
      pending.has(p) ? pending.get(p) : getChildren(p)
    const loadLocal = async (p: string): Promise<void> => {
      if (readLocal(p) !== undefined) return
      const entries = await window.electronAPI?.projectManager.listDirectory(reqWs, p) ?? []
      pending.set(p, entries)
    }
    try {
      const loadedDirs = new Set<string>()      // 已加载并展开的目录（不含 root）
      let truncated = false
      let frontier: string[] = ['.']
      while (frontier.length > 0) {
        const batch = frontier.splice(0, EXPAND_ALL_CONCURRENCY)
        await Promise.all(batch.map(loadLocal))
        if (!isCurrent(reqWs)) return
        for (const d of batch) {
          for (const c of readLocal(d) ?? []) {
            if (!c.isDir || loadedDirs.has(c.path)) continue
            if (loadedDirs.size >= EXPAND_ALL_MAX_DIRS) { truncated = true; continue }
            loadedDirs.add(c.path)
            frontier.push(c.path)
          }
        }
      }
      useFileTreeStore.getState().setChildrenBulk(Object.fromEntries(pending), reqWs)
      const next = new Set(useFileTreeStore.getState().expanded)
      for (const d of loadedDirs) next.add(d)
      useFileTreeStore.setState({expanded: next})
      setRootExpanded(true)
      if (truncated) {
        await confirm({
          title: '全部展开',
          message: `目录数已达上限 ${EXPAND_ALL_MAX_DIRS}，已展开前 ${EXPAND_ALL_MAX_DIRS} 个目录`,
          confirmText: '知道了',
        })
      }
    } finally {
      if (isCurrent(reqWs)) setExpandingAll(false)
    }
  }

  const copyPath = (e: DirEntry) => {
    void navigator.clipboard?.writeText(absPath(ws, e.path))
  }
  const openInSystem = (e: DirEntry) => {
    const api = window.electronAPI as any
    if (typeof api?.openPath === 'function') void api.openPath(absPath(ws, e.path))
    else copyPath(e) // 降级：无 shell 能力时仅复制路径
  }
  /** 删除文件/目录（不可逆，走系统回收站）；目录与文件共用同一条 deletePath。
      刷新由 watcher 的 unlink/unlinkDir → invalidateFrom 自动完成，这里不手动处理。 */
  const deleteEntry = async (e: DirEntry) => {
    const ok = await confirm({
      title: '删除',
      message: `确定删除 ${e.path}？（将移入系统回收站，可从回收站恢复）`,
      confirmText: '删除',
      confirmVariant: 'danger',
    })
    if (!ok) return
    const reqWs = ws
    try {
      await window.electronAPI?.projectManager?.deletePath(reqWs, e.path)
    } catch (err) {
      if (!isCurrent(reqWs)) return
      await confirm({title: '删除失败', message: err instanceof Error ? err.message : String(err), confirmText: '知道了'})
    }
  }

  // chevron 独立语义：切换展开；从"折叠"变"展开"时懒加载子条目
  const toggleDir = (e: DirEntry) => {
    const willExpand = !expanded.has(e.path)
    toggleExpand(e.path)
    if (willExpand) ensureChildren(e)
  }

  /** 被忽略条目在开关关闭时整体隐藏（spec §6.3） */
  const visible = (entries: DirEntry[]) => showIgnored ? entries : entries.filter(e => !e.ignored)

  /** 可见行扁平顺序（与渲染顺序一致；root 不计入），供 Shift 区间选 */
  const flatOrder = (() => {
    const out: string[] = []
    const walk = (dirPath: string) => {
      for (const e of visible(childrenCache[dirPath] ?? [])) {
        out.push(e.path)
        if (e.isDir && expanded.has(e.path)) walk(e.path)
      }
    }
    if (rootExpanded) walk('.')
    return out
  })()

  /** 路径 → 条目（判断选中项是否为目录，供「发送到会话」置灰） */
  const entryByPath = (() => {
    const m = new Map<string, DirEntry>()
    for (const entries of Object.values(childrenCache)) for (const e of entries) m.set(e.path, e)
    return m
  })()

  /** 行点击：多选语义由 store 实现（Ctrl/Cmd 切换、Shift 区间）；双击的第二次 click 另有语义 */
  const onRowClick = (path: string) => (ev: React.MouseEvent) => {
    if (ev.detail > 1) return
    selectWithMods(path, flatOrder, modsOf(ev))
  }

  /**
   * 目录染色：从 workspace 全量 statusMap 按路径前缀派生（spec §6.2）。
   * 每趟渲染只聚合一次：对每个变更文件路径，沿其各个 '/' 边界取出**所有祖先目录**
   * （即满足 `p.startsWith(dir + '/')` 的 dir），把该文件状态按 dominantStatus 的
   * 优先级语义归并进去；目录行随后 O(1) 查表。
   *
   * 语义与「对每个目录扫全量 statusMap 取 startsWith 前缀的最高优先级」完全等价：
   * dominantStatus 是按固定优先级取极值（'none' 中性），故归并可交换/结合；
   * 不依赖已加载子项 —— 折叠、从未展开的目录同样能染色（"不展开就知道哪里脏"），
   * 并天然覆盖所有祖先目录。
   */
  const dirStatusMap = useMemo(() => {
    const map = new Map<string, VcsStatus>()
    if (!statusMap) return map
    for (const path of Object.keys(statusMap)) {
      const status = statusMap[path].status
      for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
        const dir = path.slice(0, i)
        const prev = map.get(dir)
        const merged = dominantStatus(prev === undefined ? [status] : [prev, status])
        if (merged !== null) map.set(dir, merged)
      }
    }
    return map
  }, [statusMap])

  const dirStatus = (dirPath: string): VcsStatus => dirStatusMap.get(dirPath) ?? 'none'

  const renderEntries = (dirPath: string, depth: number): React.ReactNode =>
    visible(childrenCache[dirPath] ?? []).map(e => {
      const isExpanded = e.isDir && expanded.has(e.path)
      // 被忽略条目一律按"无状态"呈现（spec §6.3）
      const status: VcsStatus = e.ignored ? 'none' : (e.isDir ? dirStatus(e.path) : e.gitStatus)
      const iconSpec = e.isDir ? (isExpanded ? FOLDER_OPEN_SPEC : FOLDER_SPEC) : fileIcon(e.name)
      const Icon = iconSpec.Icon
      // 被忽略文件与隐藏文件统一弱化；目录不画删除线，所以只有文件走 pm-file-name
      const dim = e.ignored || e.name.startsWith('.')
      const nameClass = e.isDir
        ? `pm-c--${statusClassSuffix(status)}${dim ? ' pm-dim' : ''}`
        : `pm-c--${statusClassSuffix(status)} pm-file-name${dim ? ' pm-dim' : ''}`
      return (
        <Fragment key={e.path}>
          <TreeRow
            depth={depth}
            selected={selectedPath === e.path}
            expanded={isExpanded}
            hasChildren={e.isDir}
            icon={<Icon size={13} color={iconSpec.color} aria-hidden="true" />}
            label={<span className={nameClass}>{e.name}</span>}
            trailing={!e.isDir && !e.ignored && e.gitStatus !== 'none' ? <StatusBadge status={e.gitStatus} /> : undefined}
            ariaLabel={e.name}
            path={e.path}
            onClick={onRowClick(e.path)}
            onToggle={e.isDir ? () => toggleDir(e) : undefined}
            onContextMenu={ev => {
              ev.preventDefault()
              ev.stopPropagation()
              if (!useFileTreeStore.getState().selectedPaths.has(e.path)) select(e.path)
              setMenu({x: ev.clientX, y: ev.clientY, entry: e})
            }}
            onDoubleClick={() => {
              // 目录行双击 = 切换展开（IDEA 语义）
              if (e.isDir) { toggleDir(e); return }
              const reqWs = ws
              void window.electronAPI?.projectManager.readFile(reqWs, e.path).then(r => {
                // 归属守卫：期间切了 workspace / 组件已卸载 → 丢弃，不写 tab
                if (!isCurrent(reqWs)) return
                openFileTab(toOpenFileTabInput(e.path, e.name, r, e.gitStatus === 'none' ? undefined : e.gitStatus))
              })
            }}
          />
          {isExpanded && renderEntries(e.path, depth + 1)}
        </Fragment>
      )
    })

  const rootChildren = childrenCache['.'] ?? []
  const rootLabel = basename(ws)

  // 仅排除目录（含目录集合已在 hasDirSelected 分支置灰）；
  // 排序而非过滤：折叠目录不会清除选中集合，不可见项排末尾（见 lib/visibleOrder.ts）
  const fileSendPaths = sortByVisibleOrder(
    [...selectedPaths].filter(p => !entryByPath.get(p)?.isDir),
    flatOrder,
  )
  const hasDirSelected = [...selectedPaths].some(p => p === '.' || entryByPath.get(p)?.isDir)
  const sendDisabled = !!menu?.entry.isDir || fileSendPaths.length === 0 || hasDirSelected
  const sendReason = menu?.entry.isDir
    ? '目录不支持发送'
    : (hasDirSelected ? '选中项包含目录，不能发送' : (fileSendPaths.length === 0 ? '未选中文件' : undefined))

  return (
    <PanelCard testId="pm-filetree">
      <PanelHeader
        title="文件树"
        count={rootChildren.length}
        testId="pm-filetree-header"
        actions={
          <>
            <IconButton
              icon={Crosshair}
              label="在文件树中定位当前文件"
              disabled={!activeFilePath || revealing}
              onClick={() => { if (activeFilePath) requestReveal(activeFilePath) }}
            />
            <IconButton
              icon={showIgnored ? Eye : EyeOff}
              label={showIgnored ? '隐藏被忽略文件' : '显示被忽略文件'}
              pressed={showIgnored}
              onClick={() => setShowIgnored(v => !v)}
            />
            <IconButton
              icon={ChevronsUpDown}
              label="全部展开"
              disabled={expandingAll}
              onClick={() => { void expandAll() }}
            />
            <IconButton icon={ChevronsDownUp} label="全部折叠" onClick={collapseAll} />
            <IconButton icon={RefreshCw} label="刷新" onClick={loadRoot} />
          </>
        }
      />
      <div role="tree" className="pm-tree-scroll" ref={containerRef}>
        <TreeRow
          depth={0}
          icon={<FOLDER_OPEN_SPEC.Icon size={13} color={FOLDER_OPEN_SPEC.color} aria-hidden="true" />}
          label={<span className="pm-file-name pm-root-name">{rootLabel}</span>}
          hasChildren={rootChildren.length > 0}
          expanded={rootExpanded}
          selected={selectedPath === '.'}
          onClick={onRowClick('.')}
          onToggle={() => setRootExpanded(v => !v)}
          onDoubleClick={() => setRootExpanded(v => !v)}
          ariaLabel={rootLabel}
          trailing={rootChildren.length > 0 ? String(rootChildren.length) : undefined}
        />
        {rootExpanded && renderEntries('.', 1)}
        {rootChildren.length === 0 && <EmptyState text="目录为空" />}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: '发送到会话',
              disabled: sendDisabled,
              reason: sendReason,
              onClick: () => sendToConversation?.request({kind: 'files', paths: fileSendPaths}),
            },
            {label: '在文件树中显示', onClick: () => requestReveal(menu.entry.path)},
            {label: '系统打开', onClick: () => openInSystem(menu.entry)},
            {label: '复制路径', onClick: () => copyPath(menu.entry)},
            {label: '删除', danger: true, onClick: () => void deleteEntry(menu.entry)},
          ]}
        />
      )}
    </PanelCard>
  )
}
