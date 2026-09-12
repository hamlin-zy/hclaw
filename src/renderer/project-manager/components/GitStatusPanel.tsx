import React, {useEffect, useRef, useState} from 'react'
import {RefreshCw} from 'lucide-react'
import {useGitStatusStore} from '../stores/gitStatusStore'
import {useEditorTabStore} from '../stores/editorTabStore'
import {useFileTreeStore} from '../stores/fileTreeStore'
import {toOpenFileTabInput} from '../utils/fileOpenGate'
import {confirm, confirmWithInput} from '../../components/ConfirmDialog'
import {useGitLogStore} from '../stores/gitLogStore'
import {PanelCard} from '../ui/PanelCard'
import {PanelHeader} from '../ui/PanelHeader'
import {IconButton} from '../ui/IconButton'
import {TreeRow} from '../ui/TreeRow'
import {StatusBadge} from '../ui/StatusBadge'
import {EmptyState} from '../ui/EmptyState'
import {ContextMenu} from '../ui/ContextMenu'
import {FOLDER_OPEN_SPEC, FOLDER_SPEC, fileIcon} from '../lib/fileIcon'
import {statusClassSuffix, type VcsStatus} from '../lib/statusColor'
import {absPath} from '../lib/absPath'
import {applyMultiSelect, modsOf} from '../lib/multiSelect'
import {menuSendPaths} from '../lib/visibleOrder'
import {useSendToConversation} from '../ui/SendToConversationProvider'
import type {GitStatus} from '@shared/types/project-manager'

// 行内只显示文件名，目录名在聚合组标题上（spec §7 路径策略）
const fileNameOf = (p: string) => p.split('/').pop() ?? p

// 文件的父目录路径（仓库根记为 '.'），用于目录聚合与默认展开
const parentDir = (p: string) => p.split('/').slice(0, -1).join('/') || '.'

interface MenuState { x: number, y: number, file: GitStatus }

export function GitStatusPanel({workspace}: {workspace: string}) {
  const {summary, grouped, refresh} = useGitStatusStore()
  const bumpRefs = useGitStatusStore(s => s.bumpRefs)
  const loading = useGitStatusStore(s => s.loading)
  const openDiffTab = useEditorTabStore(s => s.openDiffTab)
  const openFileTab = useEditorTabStore(s => s.openFileTab)
  const requestReveal = useFileTreeStore(s => s.requestReveal)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const sendToConversation = useSendToConversation()
  const [selection, setSelection] = useState<{selected: Set<string>; anchor: string | null}>({selected: new Set(), anchor: null})
  // 目录展开态：默认展开所有目录（"详情即所见"）；summary 更新时重置
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  // 归属守卫：ws 用 ref 追踪最新值，异步回调落地前比对请求发出时的快照
  const wsRef = useRef(workspace)
  wsRef.current = workspace
  // 卸载守卫：卸载后禁止 setState / openFileTab / openDiffTab / refresh
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  /** 请求发出时的 ws 快照，落地时是否仍归属当前 workspace 且组件仍挂载 */
  const isCurrent = (reqWs: string) => mountedRef.current && wsRef.current === reqWs
  const g = grouped()
  const summaryUpdatedAt = summary?.updatedAt ?? 0
  useEffect(() => {
    if (!summary) { setExpandedDirs(new Set()); return }
    const dirs = new Set<string>()
    for (const f of Object.values(summary.statusMap)) {
      dirs.add(parentDir(f.path))
    }
    setExpandedDirs(dirs)
  }, [summaryUpdatedAt, summary])
  const toggleDir = (dir: string) => {
    setExpandedDirs(s => {
      const n = new Set(s)
      if (n.has(dir)) n.delete(dir); else n.add(dir)
      return n
    })
  }
  // 每个 status group 内按目录聚合，目录名 = path 的父目录（root = '.'）
  const groupByDir = (files: GitStatus[]): [string, GitStatus[]][] => {
    const m = new Map<string, GitStatus[]>()
    for (const f of files) {
      const d = parentDir(f.path)
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(f)
    }
    return [...m.entries()]
  }
  const renderDirGroup = (files: GitStatus[]): React.ReactNode[] =>
    groupByDir(files).map(([dir, dirFiles]) => {
      const isOpen = expandedDirs.has(dir)
      return (
        <React.Fragment key={dir}>
          <TreeRow
            depth={1}
            hasChildren
            expanded={isOpen}
            icon={<FOLDER_SPEC.Icon size={13} color={FOLDER_SPEC.color} aria-hidden="true" />}
            label={<span className="pm-group-title">{dir === '.' ? '（根目录）' : `${dir} (${dirFiles.length})`}</span>}
            onClick={() => toggleDir(dir)}
            onToggle={() => toggleDir(dir)}
            ariaLabel={dir === '.' ? '根目录' : dir}
            title="点击展开/折叠目录"
          />
          {isOpen && dirFiles.map(renderFileRow)}
        </React.Fragment>
      )
    })

  const openDiff = (f: GitStatus) => {
    const reqWs = workspace
    void window.electronAPI?.projectManager.gitDiffFile(reqWs, f.path).then(diffData => {
      // 归属守卫：期间切了 workspace / 组件已卸载 → 丢弃，不写 tab
      if (!isCurrent(reqWs)) return
      openDiffTab({filePath: f.path, title: `差异：${f.path}`, diffType: 'working-tree', diffData})
    })
      .catch(() => {
        if (!isCurrent(reqWs)) return
        void confirm({title: '无法加载 diff', message: `无法加载 ${f.path} 的 diff`, confirmText: '知道了'})
      })
  }
  const openFile = (f: GitStatus) => {
    const reqWs = workspace
    void window.electronAPI?.projectManager.readFile(reqWs, f.path).then(r => {
      // 归属守卫：期间切了 workspace / 组件已卸载 → 丢弃，不写 tab
      if (!isCurrent(reqWs)) return
      openFileTab(toOpenFileTabInput(f.path, f.path, r, '??'))
    })
  }
  const onDoubleClick = (f: GitStatus) => f.status === '??' ? openFile(f) : openDiff(f)
  const batchAdd = async () => {
    const ok = await confirm({title: '加入 Git 跟踪', message: `将 ${g.untracked.length} 个未跟踪文件加入 Git 跟踪？`, confirmText: '加入'})
    if (ok) {
      const reqWs = workspace
      void window.electronAPI?.projectManager.gitAdd(reqWs, g.untracked.map(f => f.path)).then(() => {
        // 归属守卫：期间切了 workspace / 组件已卸载 → 不把旧仓库状态刷进新仓库
        if (!isCurrent(reqWs)) return
        void refresh(reqWs)
      })
    }
  }
  const addSingle = async (f: GitStatus) => {
    const ok = await confirm({title: '加入 Git 跟踪', message: `将 ${f.path} 加入 Git 跟踪？`, confirmText: '加入'})
    if (ok) {
      const reqWs = workspace
      void window.electronAPI?.projectManager.gitAdd(reqWs, f.path).then(() => {
        if (!isCurrent(reqWs)) return
        void refresh(reqWs)
      })
    }
  }
  const removeTracked = async (f: GitStatus) => {
    const ok = await confirm({title: '移出 Git 跟踪', message: `将 ${f.path} 移出 Git 跟踪（git rm --cached，不删除本地文件）？`, confirmText: '移出', confirmVariant: 'warning'})
    if (ok) {
      const reqWs = workspace
      void window.electronAPI?.projectManager.gitRmCached(reqWs, f.path).then(() => {
        // 归属守卫：期间切了 workspace / 组件已卸载 → 不把旧仓库状态刷进新仓库
        if (!isCurrent(reqWs)) return
        void refresh(reqWs)
      })
    }
  }
  const showInTree = (f: GitStatus) => { requestReveal(f.path) }
  const copyPath = (f: GitStatus) => {
    void navigator.clipboard?.writeText(absPath(workspace, f.path))
  }
  const openInSystem = (f: GitStatus) => {
    const api = window.electronAPI as any
    if (typeof api?.openPath === 'function') void api.openPath(absPath(workspace, f.path))
    else copyPath(f) // 降级：无 shell 能力时仅复制路径
  }
  /** 丢弃更改（不可逆）：把工作区文件恢复到 HEAD / 索引状态。M/A/R 会丢掉未提交修改。 */
  const discardChanges = async (f: GitStatus) => {
    const risky = f.status === 'M' || f.status === 'A' || f.status === 'R'
    const ok = await confirm({
      title: '丢弃更改',
      message: risky
        ? `确定丢弃 ${f.path} 的更改？未提交的修改将丢失，且无法从回收站恢复。`
        : `确定丢弃 ${f.path} 的更改？`,
      confirmText: '丢弃',
      confirmVariant: 'danger',
    })
    if (!ok) return
    const reqWs = workspace
    try {
      await window.electronAPI?.projectManager?.gitDiscard(reqWs, f.path, f.status)
    } catch (e) {
      if (isCurrent(reqWs)) await confirm({title: '丢弃失败', message: errText(e), confirmText: '知道了'})
    }
  }
  /** 删除文件（不可逆，走系统回收站）：会同时影响 git 状态。 */
  const deleteFile = async (f: GitStatus) => {
    const ok = await confirm({
      title: '删除文件',
      message: `确定删除 ${f.path}？该文件将移入系统回收站（可从回收站恢复），这会影响仓库的 git 状态。`,
      confirmText: '删除',
      confirmVariant: 'danger',
    })
    if (!ok) return
    const reqWs = workspace
    try {
      await window.electronAPI?.projectManager?.deletePath(reqWs, f.path)
    } catch (e) {
      if (isCurrent(reqWs)) await confirm({title: '删除失败', message: errText(e), confirmText: '知道了'})
    }
  }

  const changed = summary ? Object.keys(summary.statusMap).length : 0
  /** 手动刷新：自动推送链路（工作区 watcher + gitdir watcher）不可用时给用户的兜底入口。
      归属/代际守卫在 store.refresh 内部（generation + ws 比对），这里只取当前 ws 快照。 */
  const reloadStatus = () => {
    const reqWs = workspace
    // refresh 的 try/finally 只保证 loading 复位，不吞 IPC 错误；手动刷新是纯兜底入口，
    // 失败无处上报，补 catch 避免 unhandled rejection（loading 复位仍在 store 的 finally 里）
    void refresh(reqWs).catch(() => {})
  }
  // 提交区状态机（spec §2.2）：busy 由提交流程驱动
  const [busy, setBusy] = useState<null | 'commit' | 'push'>(null)
  const trackedChanges = summary ? Object.values(summary.statusMap).filter(s => s.status !== '??').length : 0
  const onlyUntracked = changed > 0 && trackedChanges === 0
  const actionsDisabled = onlyUntracked || busy !== null
  const DISABLED_HINT = '没有可提交的已跟踪变更，请先把未跟踪文件加入 Git 跟踪'
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

  /** 提交后的刷新面（spec §4.4）：变更列表 → commit 列表 → refs（分支树 / Git 区头部）
      刷新面失败不影响"提交已成功"的结论，也不得冒泡为未处理拒绝 */
  const afterCommitSuccess = async (reqWs: string) => {
    if (!isCurrent(reqWs)) return
    try {
      await refresh(reqWs)
      if (!isCurrent(reqWs)) return
      await useGitLogStore.getState().loadInitial(reqWs)
      if (!isCurrent(reqWs)) return
      bumpRefs()
    } catch {
      /* 刷新失败：静默，提交结果保持成功 */
    }
  }

  const runSubmit = async (thenPush: boolean) => {
    const pm = window.electronAPI?.projectManager
    if (!pm) return                                   // preload 不可用：不动
    const reqWs = workspace

    const msg = await confirmWithInput({
      title: '提交',
      inputLabel: '提交信息',
      message: '将提交所有已跟踪文件的变更（git commit -a）。未跟踪文件需先加入 Git 跟踪。',
      placeholder: '简要描述本次提交',
      multiline: true,
      confirmText: '提交',
    })
    if (msg === null) return                          // 取消：零写调用
    if (!isCurrent(reqWs)) return

    setBusy('commit')
    try {
      await pm.gitCommit(reqWs, msg)
    } catch (e) {
      if (isCurrent(reqWs)) await confirm({title: '提交失败', message: errText(e), confirmText: '知道了'})
      return                                          // 提交失败：绝不进入刷新与推送
    } finally {
      if (isCurrent(reqWs)) setBusy(null)
    }

    await afterCommitSuccess(reqWs)

    if (!thenPush || !isCurrent(reqWs)) return
    setBusy('push')
    try {
      await pm.gitPush(reqWs)
    } catch (e) {
      // 提交已生效，绝不能说整体失败——否则用户会重复提交（spec §4.4）
      if (isCurrent(reqWs)) await confirm({title: '提交成功，但推送失败', message: errText(e), confirmText: '知道了'})
      return
    } finally {
      if (isCurrent(reqWs)) setBusy(null)
    }

    if (!isCurrent(reqWs)) return
    try { await refresh(reqWs) } catch { /* 刷新失败：静默，推送已成功 */ }
    if (!isCurrent(reqWs)) return
    bumpRefs()
  }
  const groups: Array<[string, VcsStatus, GitStatus[]]> = [
    ['已修改', 'M', g.modified], ['已新增', 'A', g.added], ['已删除', 'D', g.deleted], ['已重命名', 'R', g.renamed],
  ]

  /** 可见文件行的显示顺序（目录展开时才计入其文件），供 Shift 区间选 */
  const flatOrder = (() => {
    const out: string[] = []
    const push = (files: GitStatus[]) => {
      for (const [dir, dirFiles] of groupByDir(files)) {
        if (expandedDirs.has(dir)) for (const f of dirFiles) out.push(f.path)
      }
    }
    for (const [, , files] of groups) push(files)
    push(g.untracked)
    return out
  })()

  // 排序而非过滤：flatOrder 只含当前可见行，折叠目录不清除选中集合；
  // 选中集合按显示顺序排列，不可见项排末尾（见 lib/visibleOrder.ts）。

  const renderFileRow = (f: GitStatus) => {
    const {Icon, color} = fileIcon(fileNameOf(f.path))
    return (
      <TreeRow
        key={f.path}
        depth={2}
        icon={<Icon size={13} color={color} aria-hidden="true" />}
        label={<span className={`pm-c--${statusClassSuffix(f.status)} pm-file-name`}>{fileNameOf(f.path)}</span>}
        trailing={f.status === '??' ? undefined : <StatusBadge status={f.status} />}
        ariaLabel={f.path}
        title={f.status === 'R' ? `${f.oldPath} → ${f.path}` : f.path}
        selected={selection.selected.has(f.path)}
        onClick={ev => {
          if (ev.detail > 1) return   // 双击另有语义（打开 diff / 文件）
          const r = applyMultiSelect(selection, f.path, flatOrder, modsOf(ev))
          setSelection({selected: r.selected, anchor: r.anchor})
        }}
        onDoubleClick={() => onDoubleClick(f)}
        onContextMenu={ev => {
          ev.preventDefault()
          ev.stopPropagation()
          if (!selection.selected.has(f.path)) setSelection({selected: new Set([f.path]), anchor: f.path})
          setMenu({x: ev.clientX, y: ev.clientY, file: f})
        }}
      />
    )
  }

  const renderGroupTitle = (label: string, status: VcsStatus, onDoubleClick?: () => void) => (
    <TreeRow
      depth={0}
      hasChildren
      expanded
      icon={<FOLDER_OPEN_SPEC.Icon size={13} color={FOLDER_OPEN_SPEC.color} aria-hidden="true" />}
      label={<span className={`pm-group-title pm-c--${statusClassSuffix(status)}`}>{label}</span>}
      ariaLabel={label}
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? '双击全部加入跟踪（需确认）' : undefined}
    />
  )

  return (
    <PanelCard testId="pm-changes">
      <PanelHeader
        title="变更列表"
        count={changed}
        testId="pm-changes-header"
        actions={<IconButton icon={RefreshCw} label="刷新" disabled={loading} onClick={reloadStatus} />}
      />
      {!summary
        ? <EmptyState text="工作区干净" />
        : (
          <div role="tree" className="pm-tree-scroll">
            {groups.map(([label, status, files]) => files.length > 0 && (
              <React.Fragment key={label}>
                {renderGroupTitle(`${label} (${files.length})`, status)}
                {renderDirGroup(files)}
              </React.Fragment>
            ))}
            {g.untracked.length > 0 && (
              // 未跟踪分组：与上方「已跟踪变更」树用横线 + 灰色调分开（.pm-untracked-section）
              <div className="pm-untracked-section" data-testid="pm-untracked-section">
                {renderGroupTitle(`未跟踪文件 (${g.untracked.length})`, '??', () => { void batchAdd() })}
                {renderDirGroup(g.untracked)}
              </div>
            )}
          </div>
        )}
      {summary && (
        <div className="pm-changes-summary" data-testid="pm-changes-summary">
          {changed ? `已更改 ${changed} 个文件 · +${summary.additions} · −${summary.deletions}` : '工作区干净'}
        </div>
      )}
      {summary && changed > 0 && (
        <div className="pm-changes-actions" data-testid="pm-changes-actions">
          <button
            type="button"
            className={`pm-changes-btn pm-changes-btn--primary${actionsDisabled ? ' is-disabled' : ''}`}
            aria-disabled={actionsDisabled}
            aria-label="提交"
            title={onlyUntracked ? DISABLED_HINT : undefined}
            onClick={() => { if (!actionsDisabled) void runSubmit(false) }}
          >
            {busy === 'commit' ? '提交中…' : '提交'}
          </button>
          <button
            type="button"
            className={`pm-changes-btn${actionsDisabled ? ' is-disabled' : ''}`}
            aria-disabled={actionsDisabled}
            aria-label="提交并推送"
            title={onlyUntracked ? DISABLED_HINT : undefined}
            onClick={() => { if (!actionsDisabled) void runSubmit(true) }}
          >
            {busy === 'push' ? '推送中…' : '提交并推送'}
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={menu.file.status === '??' ? [
            {
              label: '发送到会话',
              onClick: () => sendToConversation?.request({
                kind: 'files',
                paths: menuSendPaths(selection.selected, flatOrder, menu.file.path),
              }),
            },
            {label: '编辑区打开', onClick: () => openFile(menu.file)},
            {label: '文件树中显示', onClick: () => showInTree(menu.file)},
            {label: '系统打开', onClick: () => openInSystem(menu.file)},
            {label: '复制路径', onClick: () => copyPath(menu.file)},
            {label: '删除文件', danger: true, onClick: () => void deleteFile(menu.file)},
            {label: '加入 Git 跟踪', onClick: () => void addSingle(menu.file)},
          ] : [
            {
              label: '发送到会话',
              onClick: () => sendToConversation?.request({
                kind: 'files',
                paths: menuSendPaths(selection.selected, flatOrder, menu.file.path),
              }),
            },
            {label: 'Diff 打开', onClick: () => openDiff(menu.file)},
            {label: '文件树中显示', onClick: () => showInTree(menu.file)},
            {label: '系统打开', onClick: () => openInSystem(menu.file)},
            {label: '复制路径', onClick: () => copyPath(menu.file)},
            {label: '丢弃更改', danger: true, onClick: () => void discardChanges(menu.file)},
            {label: '删除文件', danger: true, onClick: () => void deleteFile(menu.file)},
            {label: '移出 Git 跟踪', onClick: () => void removeTracked(menu.file)},
          ]}
        />
      )}
    </PanelCard>
  )
}
