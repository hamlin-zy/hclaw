import {Fragment, useEffect, useMemo, useRef, useState} from 'react'
import {Copy, FileText, GitCompare, Terminal} from 'lucide-react'
import {useGitLogStore} from '../stores/gitLogStore'
import {useEditorTabStore} from '../stores/editorTabStore'
import {PanelCard} from '../ui/PanelCard'
import {PanelHeader} from '../ui/PanelHeader'
import {TreeRow} from '../ui/TreeRow'
import {StatusBadge} from '../ui/StatusBadge'
import {EmptyState} from '../ui/EmptyState'
import {IconButton} from '../ui/IconButton'
import {FOLDER_OPEN_SPEC, fileIcon} from '../lib/fileIcon'
import {applyMultiSelect, modsOf} from '../lib/multiSelect'
import {menuSendPaths} from '../lib/visibleOrder'
import {statusClassSuffix} from '../lib/statusColor'
import {ContextMenu} from '../ui/ContextMenu'
import {useSendToConversation} from '../ui/SendToConversationProvider'
import type {GitCommitFiles, GitCommitFile, DiffResult} from '@shared/types/project-manager'

// 预取节流：超过该文件数的 commit 不预取（避免 merge commit 并发数百次 IPC 全量驻留），双击走异步兜底
const PREFETCH_FILE_LIMIT = 20

// 行内只显示文件名，目录名在聚合组标题上（spec §7 路径策略）
const fileNameOf = (p: string) => p.split('/').pop() ?? p

// 文件的父目录路径（仓库根记为 '.'），用于目录聚合与默认展开
const parentDir = (p: string) => p.split('/').slice(0, -1).join('/') || '.'

export function GitCommitDetail({workspace}: {workspace: string}) {
  const selectedHash = useGitLogStore(s => s.selectedHash)
  const entries = useGitLogStore(s => s.entries)
  const openDiffTab = useEditorTabStore(s => s.openDiffTab)
  const openFileTab = useEditorTabStore(s => s.openFileTab)
  const [detail, setDetail] = useState<GitCommitFiles | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  // 多选（Ctrl/Shift）；selectedFilePath 是其主选（Compare 仍读它）
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [anchorPath, setAnchorPath] = useState<string | null>(null)
  const [menu, setMenu] = useState<{x: number, y: number, path: string} | null>(null)
  const sendToConversation = useSendToConversation()
  // 目录展开态：切换 commit 时重置（默认展开所有目录，符合"详情即所见"）
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  // 预取各文件 diff 缓存，键为 `${hash}:${path}`：换 commit 后旧键不再命中，防止串数据
  const [diffCache, setDiffCache] = useState<Map<string, DiffResult>>(new Map())
  // 双击 miss 时的异步兜底加载提示
  const [loadingPath, setLoadingPath] = useState<string | null>(null)

  // 归属守卫：ws 用 ref 追踪最新值，异步回调落地前比对请求发出时的快照
  const wsRef = useRef(workspace)
  wsRef.current = workspace
  // 卸载守卫：卸载后禁止 setState / openFileTab / openDiffTab
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  /** 请求发出时的 ws 快照，落地时是否仍归属当前 workspace 且组件仍挂载 */
  const isCurrent = (reqWs: string) => mountedRef.current && wsRef.current === reqWs

  useEffect(() => {
    if (!selectedHash) { setDetail(null); return }
    let cancelled = false
    setDetail(null)
    setSelectedFilePath(null)
    setSelectedPaths(new Set())
    setAnchorPath(null)
    setDiffCache(new Map())
    void window.electronAPI?.projectManager.gitShowCommit(workspace, selectedHash).then(d => {
      if (cancelled) return   // 代际守卫：快速切换 commit 时丢弃过期结果
      setDetail(d)
      const first = d.files[0]?.path ?? null
      setSelectedFilePath(first)
      setSelectedPaths(first ? new Set([first]) : new Set())
      setAnchorPath(first)
      // 默认展开所有目录（详情即所见），切换 commit 时重置
      setExpandedDirs(new Set(d.files.map(f => parentDir(f.path))))
      if (d.files.length > PREFETCH_FILE_LIMIT) return
      const cache = new Map<string, DiffResult>()
      // 顺序预取，避免一次 commit 触发大量并发 IPC
      void (async () => {
        for (const f of d.files) {
          try {
            const diff = await window.electronAPI?.projectManager.gitDiffFile(workspace, f.path, {ref: selectedHash})
            if (cancelled) return
            if (diff) {
              cache.set(`${selectedHash}:${f.path}`, diff)
              setDiffCache(new Map(cache))
            }
          } catch {
            if (cancelled) return
            // 预取失败静默跳过，双击走异步兜底
          }
        }
      })()
    })
    return () => { cancelled = true }
  }, [selectedHash, workspace])

  const commit = entries.find(e => e.hash === selectedHash)

  // 按目录聚合为树（两级展示：目录 → 文件）
  const tree = useMemo(() => {
    const dirs = new Map<string, GitCommitFile[]>()
    for (const f of detail?.files ?? []) {
      const dir = parentDir(f.path)
      if (!dirs.has(dir)) dirs.set(dir, [])
      dirs.get(dir)!.push(f)
    }
    return dirs
  }, [detail])

  /** 当前展开目录下的文件显示顺序（供 Shift 区间选） */
  const flatOrder = [...tree.entries()].flatMap(([dir, files]) =>
    expandedDirs.has(dir) ? files.map(f => f.path) : [])

  const openDiffFor = (path: string, diffData: DiffResult, ref: string, title: string) =>
    openDiffTab({filePath: path, title, diffType: 'commit', ref, diffData})

  // 双击打开：命中缓存同步打开；miss（未预取/预取失败/未就绪）走异步兜底
  const openOnDoubleClick = (path: string) => {
    if (!selectedHash) return
    const title = `Diff: ${fileNameOf(path)} @ ${commit?.abbreviatedHash ?? ''}`
    const cached = diffCache.get(`${selectedHash}:${path}`)
    if (cached) {
      openDiffFor(path, cached, selectedHash, title)
      return
    }
    if (loadingPath) return
    const reqWs = workspace
    setLoadingPath(path)
    void window.electronAPI?.projectManager.gitDiffFile(reqWs, path, {ref: selectedHash}).then(diff => {
      // 归属守卫：期间切了 workspace / 组件已卸载 → 丢弃，不写 tab
      if (!isCurrent(reqWs)) return
      if (diff) openDiffFor(path, diff, selectedHash, title)
    }).catch(() => {}).finally(() => {
      // 卸载后不得 setState；仅清掉本次占用的 loading 提示（避免覆盖后续请求的提示）
      if (mountedRef.current) setLoadingPath(cur => (cur === path ? null : cur))
    })
  }

  if (!selectedHash || !commit) {
    return (
      <PanelCard testId="pm-commit-detail">
        <PanelHeader title="Commit 详情" testId="pm-detail-header" />
        <EmptyState text="选中一个 commit 查看变更详情" />
      </PanelCard>
    )
  }

  const selectedFile = detail?.files.find(f => f.path === selectedFilePath) ?? null

  const toggleDir = (dir: string) => {
    setExpandedDirs(s => {
      const n = new Set(s)
      if (n.has(dir)) n.delete(dir); else n.add(dir)
      return n
    })
  }

  const renderFileRow = (f: GitCommitFile) => {
    const {Icon, color} = fileIcon(fileNameOf(f.path))
    return (
      <TreeRow
        key={f.path}
        depth={2}
        icon={<Icon size={13} color={color} aria-hidden="true" />}
        label={
          <span className={`pm-c--${statusClassSuffix(f.status)} pm-file-name`}>
            {fileNameOf(f.path)}{loadingPath === f.path ? ' …' : ''}
          </span>
        }
        trailing={<StatusBadge status={f.status} />}
        selected={selectedPaths.has(f.path)}
        ariaLabel={f.path}
        title={`${f.path} · ${f.status} · +${f.additions} -${f.deletions} · 双击打开 Diff`}
        onClick={ev => {
          if (ev.detail > 1) return   // 双击另开 diff
          const r = applyMultiSelect({selected: selectedPaths, anchor: anchorPath}, f.path, flatOrder, modsOf(ev))
          setSelectedPaths(r.selected)
          setAnchorPath(r.anchor)
          setSelectedFilePath(r.main)
        }}
        onContextMenu={ev => {
          ev.preventDefault()
          ev.stopPropagation()
          if (!selectedPaths.has(f.path)) {
            setSelectedPaths(new Set([f.path]))
            setAnchorPath(f.path)
            setSelectedFilePath(f.path)
          }
          setMenu({x: ev.clientX, y: ev.clientY, path: f.path})
        }}
        onDoubleClick={() => openOnDoubleClick(f.path)}
      />
    )
  }

  const actions = (
    <>
      <IconButton icon={Copy} label="Copy hash" onClick={() => void navigator.clipboard.writeText(commit.hash)} />
      <IconButton icon={FileText} label="Copy message" onClick={() => void navigator.clipboard.writeText(commit.message)} />
      {/* Show in Terminal = 编辑区只读 tab 显示 git show（pm:git-show-detail），历史设计决定 */}
      <IconButton
        icon={Terminal}
        label="Show in Terminal"
        onClick={() => {
          const reqWs = workspace
          void window.electronAPI?.projectManager.gitShowDetail(reqWs, commit.hash).then(text => {
            // 归属守卫：期间切了 workspace / 组件已卸载 → 丢弃
            if (!isCurrent(reqWs)) return
            openFileTab({path: `__show__${commit.hash}`, title: `Show: ${commit.abbreviatedHash}`, content: text, hash: `show-${commit.hash}`})
          })
        }}
      />
      {/* Compare with HEAD：选中 commit（本组件即选中态）+ 选中文件时可用；ref 用 `${hash}..HEAD` 与双击 tab 键区分 */}
      <IconButton
        icon={GitCompare}
        label="Compare with HEAD"
        disabled={!selectedFile}
        onClick={() => {
          const f = selectedFile
          if (!f) return
          const reqWs = workspace
          void window.electronAPI?.projectManager.gitDiffFile(reqWs, f.path, {from: commit.hash, to: 'HEAD'}).then(diffData => {
            // 归属守卫：期间切了 workspace / 组件已卸载 → 丢弃
            if (!isCurrent(reqWs)) return
            openDiffTab({filePath: f.path, title: `Diff: ${fileNameOf(f.path)} vs HEAD`, diffType: 'commit', ref: `${commit.hash}..HEAD`, diffData})
          })
        }}
      />
      {/* Checkout：本窗口不支持（title 说明原因） */}
      <button type="button" className="pm-header-action" disabled title="本窗口不支持 Checkout">Checkout</button>
    </>
  )

  return (
    <PanelCard testId="pm-commit-detail">
      <PanelHeader title="Commit 详情" testId="pm-detail-header" actions={actions} />
      <div className="pm-detail-scroll">
        <div>{detail?.files.length ?? 0} files changed</div>
        {[...tree.entries()].map(([dir, files]) => {
          const isOpen = expandedDirs.has(dir)
          return (
            <Fragment key={dir}>
              <TreeRow
                depth={1}
                hasChildren
                expanded={isOpen}
                icon={<FOLDER_OPEN_SPEC.Icon size={13} color={FOLDER_OPEN_SPEC.color} aria-hidden="true" />}
                label={<span className="pm-group-title">{dir === '.' ? '(root)' : `${dir} (${files.length} files)`}</span>}
                onClick={() => toggleDir(dir)}
                onToggle={() => toggleDir(dir)}
                ariaLabel={dir}
                title="点击展开/折叠目录"
              />
              {isOpen && files.map(renderFileRow)}
            </Fragment>
          )
        })}
      </div>
      <div className="pm-detail-footer">
        <div className="pm-detail-message">{commit.message}</div>
        {commit.body && <div className="pm-detail-body">{commit.body}</div>}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{
            label: '发送到会话',
            onClick: () => sendToConversation?.request({
              kind: 'files',
              paths: menuSendPaths(selectedPaths, flatOrder, menu.path),
            }),
          }]}
        />
      )}
    </PanelCard>
  )
}
