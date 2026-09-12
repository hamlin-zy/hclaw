// 分支树（spec §8）：独立搜索框 + 四级分组（HEAD / Local / Remote → 远端名 / Tags）。
//
// 两条铁律：
//   1. 分支搜索只过滤分支/标签，**绝不调用 gitLogStore.applyFilters**（spec §8.1 / §16.2）。
//   2. 分支行点击仍调 applyFilters（过滤 Commit 列表到该分支可达的 commit），现有行为保留。
//
// 分组标题一律走 TreeRow —— spec §13.1 要求终态只保留「动态计算值」的内联样式
// （缩进像素、拖拽宽度），手写 role="button" 表头携带的静态内联样式不允许保留。
//
// 目录化（本次）：Local / Remote 组内分支名里的 `/` 渲染成可折叠目录层级（IDEA Git Branches 行为）。
// Tags 与 HEAD 组保持扁平。目录行只负责展开/折叠，绝不触发 applyFilters。
import React, {Fragment, useEffect, useMemo, useState} from 'react'
import {GitBranch} from 'lucide-react'
import {useWorkspaceStore} from '../stores/workspaceStore'
import {useGitStatusStore} from '../stores/gitStatusStore'
import {useGitLogStore} from '../stores/gitLogStore'
import type {BranchTreeNode} from '@shared/types/project-manager'
import {FOLDER_OPEN_SPEC, FOLDER_SPEC} from '../lib/fileIcon'
import {PanelCard} from '../ui/PanelCard'
import {PanelHeader} from '../ui/PanelHeader'
import {PanelToolbar} from '../ui/PanelToolbar'
import {SearchInput} from '../ui/SearchInput'
import {TreeRow} from '../ui/TreeRow'
import {EmptyState} from '../ui/EmptyState'
import {ContextMenu} from '../ui/ContextMenu'

interface MenuState { x: number, y: number, node: BranchTreeNode }

interface RowProps {
  selectedName: string | null
  /** 已归一化的搜索词（trim + toLowerCase）；空串表示无查询 */
  query: string
  onBranchClick: (n: BranchTreeNode) => void
  onBranchContextMenu: (n: BranchTreeNode, e: React.MouseEvent) => void
}

const ROW_TITLE = '右键：Checkout（本窗口禁用）/ Copy name / Copy hash / Compare with HEAD'

/**
 * 分支行的显示名：远端分支剥掉 `<remoteName>/` 前缀（spec §8.2 示意中 `origin` 组下直接列 `main`/`develop`）。
 * 目录化后它同时作为分支树的「相对路径」（不含远端名前缀）；aria-label 仍用完整短 ref，保证可访问名唯一。
 */
function displayName(n: BranchTreeNode): string {
  if (n.isRemote && n.remoteName && n.name.startsWith(`${n.remoteName}/`)) {
    return n.name.slice(n.remoteName.length + 1)
  }
  return n.name
}

/** Local 组分支树用：本地分支的 name 就是相对路径（不与远端名前缀剥离） */
const localPathOf = (n: BranchTreeNode) => n.name

/**
 * 命中段高亮（spec §8.1：子串包含、忽略大小写，命中的分支高亮匹配段）。
 * 用 indexOf 定位区间而非 `new RegExp(query)` —— 用户输入是字面子串，
 * 拼进正则会被 `.`、`(`、`[` 等元字符破坏。span 内保留原串大小写。
 */
function highlightMatch(text: string, q: string): React.ReactNode {
  if (!q) return text
  const idx = text.toLowerCase().indexOf(q)
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <span className="pm-search-match">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  )
}

/** 分支行（HEAD 组直系、Local/Remote 目录树叶子共用） */
function branchRow(n: BranchTreeNode, depth: number, props: RowProps, ariaLabel = n.name, segment = displayName(n)) {
  const selected = props.selectedName === n.name && n.type !== 'tag'
  return (
    <TreeRow
      key={`${n.type}:${ariaLabel}`}
      depth={depth}
      selected={selected}
      icon={<GitBranch size={13} color="var(--text-secondary)" aria-hidden="true" />}
      // aria-label 用完整 n.name（可访问名不因高亮而变），只对显示出来的段名做命中段包裹
      label={
        <span className={n.isCurrent ? 'pm-c--current' : undefined}>
          {n.isCurrent ? '★ ' : ''}{highlightMatch(segment, props.query)}
        </span>
      }
      ariaLabel={ariaLabel}
      title={ROW_TITLE}
      onClick={() => props.onBranchClick(n)}
      onContextMenu={ev => props.onBranchContextMenu(n, ev)}
    />
  )
}

/** 顶层分组（HEAD / Tags）：可折叠标题 + 直系分支行，空组不渲染（保持扁平） */
function BranchGroup({label, list, prefix, ...props}: {
  label: string
  list: BranchTreeNode[]
  /** 可访问名前缀（HEAD 组用 `HEAD ` 与 Local 组同名分支消歧） */
  prefix?: string
} & RowProps) {
  const [open, setOpen] = useState(true)
  if (list.length === 0) return null
  return (
    <Fragment>
      <TreeRow
        depth={0}
        hasChildren
        expanded={open}
        label={<span className="pm-group-title">{label}</span>}
        ariaLabel={label}
        onClick={() => setOpen(v => !v)}
        onToggle={() => setOpen(v => !v)}
      />
      {open && list.map(n => branchRow(n, 1, props, prefix ? `${prefix}${n.name}` : n.name))}
    </Fragment>
  )
}

/** 目录节点：`/` 拆分后的层级结构（同一层可同时存在同名目录与叶子，见 buildDirTree 注释） */
interface DirNode {
  /** 当前路径段名（如 `feature`） */
  name: string
  /** 相对路径（不含 aria 前缀），如 `feature` / `feature/sub` */
  path: string
  dirs: Map<string, DirNode>
  leaves: {branch: BranchTreeNode, segment: string}[]
}

/**
 * 按 `/` 把分支列表构造成目录树。
 * 关键边界：同一层允许「目录名 == 叶子段名」共存（本地同时有 `feat` 与 `feat/x`）——
 * 叶子挂在 leaves、目录挂在 dirs，二者互不覆盖，渲染时都不丢。
 */
function buildDirTree(list: BranchTreeNode[], pathOf: (n: BranchTreeNode) => string): DirNode {
  const root: DirNode = {name: '', path: '', dirs: new Map(), leaves: []}
  for (const b of list) {
    const segs = pathOf(b).split('/')
    let cur = root
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]
      let child = cur.dirs.get(seg)
      if (!child) {
        child = {name: seg, path: segs.slice(0, i + 1).join('/'), dirs: new Map(), leaves: []}
        cur.dirs.set(seg, child)
      }
      cur = child
    }
    cur.leaves.push({branch: b, segment: segs[segs.length - 1]})
  }
  return root
}

/**
 * 目录化的分支列表（Local 组、Remote 二级组下共用）。
 * - 目录行：TreeRow + hasChildren，点击/chevron 只切换折叠，不碰 applyFilters，无右键菜单。
 * - 叶子行：branchRow 原样（GitBranch 图标、右键菜单、点击 applyFilters）。
 * - 折叠状态按目录路径（含 aria 前缀）记忆，未记过的目录默认展开。
 * - 搜索词非空时目录强制展开（祖先目录必须可见），清空后恢复用户折叠态。
 */
function FolderTree({list, baseDepth, pathOf, ariaPrefix, ...props}: {
  list: BranchTreeNode[]
  /** 该组目录树第一层的 depth（Local = 1，Remote 二级组下 = 3） */
  baseDepth: number
  /** 分支 → 相对路径（Local 用 name，Remote 用 displayName 剥掉远端名前缀） */
  pathOf: (n: BranchTreeNode) => string
  /** 目录 aria-label 前缀（Remote 用 `<remoteName>/`，Local 为空串） */
  ariaPrefix: string
} & RowProps) {
  // 记「折叠的」目录而非「展开的」：默认全展开，新增目录自动是展开态
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const root = useMemo(() => buildDirTree(list, pathOf), [list, pathOf])
  const toggleDir = (path: string) => setClosed(prev => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  // 目录优先于同名的叶子渲染，保证层级稳定且不丢任一侧
  const renderLevel = (node: DirNode, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = []
    for (const child of node.dirs.values()) {
      const dirPath = `${ariaPrefix}${child.path}`
      const open = props.query !== '' || !closed.has(dirPath)
      const spec = open ? FOLDER_OPEN_SPEC : FOLDER_SPEC
      const Icon = spec.Icon
      rows.push(
        <TreeRow
          key={`dir:${dirPath}`}
          depth={depth}
          hasChildren
          expanded={open}
          icon={<Icon size={13} color={spec.color} aria-hidden="true" />}
          label={<span className="pm-branch-dir">{highlightMatch(child.name, props.query)}</span>}
          ariaLabel={dirPath}
          onClick={() => toggleDir(dirPath)}
          onToggle={() => toggleDir(dirPath)}
        />,
      )
      if (open) rows.push(...renderLevel(child, depth + 1))
    }
    for (const {branch, segment} of node.leaves) {
      rows.push(branchRow(branch, depth, props, `${ariaPrefix}${pathOf(branch)}`, segment))
    }
    return rows
  }
  return <Fragment>{renderLevel(root, baseDepth)}</Fragment>
}

/** Local 组：可折叠标题 + 目录化的本地分支树 */
function LocalGroup({list, ...props}: {list: BranchTreeNode[]} & RowProps) {
  const [open, setOpen] = useState(true)
  if (list.length === 0) return null
  return (
    <Fragment>
      <TreeRow
        depth={0}
        hasChildren
        expanded={open}
        label={<span className="pm-group-title">Local</span>}
        ariaLabel="Local"
        onClick={() => setOpen(v => !v)}
        onToggle={() => setOpen(v => !v)}
      />
      {open && <FolderTree list={list} baseDepth={1} pathOf={localPathOf} ariaPrefix="" {...props} />}
    </Fragment>
  )
}

/** Remote 两级分组（spec §8.2）：Remote → <远端名> → 目录化分支树 */
function RemoteGroups({branches, ...props}: {branches: BranchTreeNode[]} & RowProps) {
  const [open, setOpen] = useState(true)
  // 记「折叠的」远端而非「展开的」：默认全展开，新增远端自动是展开态
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const byRemote = useMemo(() => {
    const m = new Map<string, BranchTreeNode[]>()
    for (const b of branches) {
      const remote = b.remoteName ?? 'remote'
      if (!m.has(remote)) m.set(remote, [])
      m.get(remote)!.push(b)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [branches])
  if (branches.length === 0) return null
  const toggleRemote = (remote: string) => setClosed(prev => {
    const next = new Set(prev)
    if (next.has(remote)) next.delete(remote)
    else next.add(remote)
    return next
  })
  return (
    <Fragment>
      <TreeRow
        depth={0}
        hasChildren
        expanded={open}
        label={<span className="pm-group-title">{`Remote (${branches.length})`}</span>}
        ariaLabel="Remote"
        onClick={() => setOpen(v => !v)}
        onToggle={() => setOpen(v => !v)}
      />
      {open && byRemote.map(([remote, list]) => {
        const expanded = !closed.has(remote)
        return (
          <Fragment key={remote}>
            <TreeRow
              depth={2}
              hasChildren
              expanded={expanded}
              label={<span className="pm-group-title">{`${remote} (${list.length})`}</span>}
              ariaLabel={remote}
              onClick={() => toggleRemote(remote)}
              onToggle={() => toggleRemote(remote)}
            />
            {expanded && <FolderTree list={list} baseDepth={3} pathOf={displayName} ariaPrefix={`${remote}/`} {...props} />}
          </Fragment>
        )
      })}
    </Fragment>
  )
}

export function GitBranchTree() {
  const ws = useWorkspaceStore(s => s.workspacePath)
  const applyFilters = useGitLogStore(s => s.applyFilters)
  const selectedHash = useGitLogStore(s => s.selectedHash)
  const selectedBranch = useGitLogStore(s => s.selectedBranch)
  const [nodes, setNodes] = useState<BranchTreeNode[]>([])
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  // commit/push 后 refsVersion 自增 → 重跑下方的分支拉取 effect，tip/分支列表不陈旧
  const refsVersion = useGitStatusStore(s => s.refsVersion)
  useEffect(() => {
    if (!ws) { setNodes([]); return }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const load = async () => {
      const n = await window.electronAPI?.projectManager.gitBranches(ws) ?? []
      if (cancelled) return
      setNodes(n)
      // git 检测可能早期失败（工作区索引未就绪），首次返回空数组时 800ms 后重试一次。
      // 仅重试一次，避免对"真·非 git 仓库"的无限轮询。
      if (n.length === 0) {
        retryTimer = setTimeout(() => {
          if (cancelled) return
          void window.electronAPI?.projectManager.gitBranches(ws).then(r => {
            if (!cancelled) setNodes(r ?? [])
          })
        }, 800)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [ws, refsVersion])

  // 分支搜索：纯前端本地过滤（分支数量有限，无需 IPC），输入即过滤、无防抖。
  // 只过滤分支/标签，不碰 gitLogStore（spec §8.1：这是与「单一搜索框属于 Commit 列表」最大的差别）。
  // 归一化后的搜索词同时供「过滤」与「命中段高亮」使用，两处口径必须一致。
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!normalizedQuery) return nodes
    return nodes.filter(n => n.name.toLowerCase().includes(normalizedQuery))
  }, [nodes, normalizedQuery])

  // Local 组保留当前分支（IDEA 语义：Local 组包含 current）；
  // HEAD 组通过可访问名前缀 `HEAD ` 与 Local 组的同名分支消歧，避免 getByRole multiple-match。
  const headName = nodes.find(n => n.isCurrent)?.name ?? 'detached'
  const headNode = filtered.find(n => n.isCurrent)
  const headList = headNode ? [headNode] : []

  const rowProps: RowProps = {
    selectedName: selectedBranch,
    query: normalizedQuery,
    onBranchClick: n => {
      if (n.type !== 'tag') void applyFilters(ws, {limit: 100, filterBranch: [n.name]})
    },
    onBranchContextMenu: (n, ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      setMenu({x: ev.clientX, y: ev.clientY, node: n})
    },
  }

  return (
    <PanelCard testId="pm-branches">
      <PanelHeader title="分支" count={nodes.length} testId="pm-branches-header" />
      <PanelToolbar testId="pm-branches-toolbar">
        {/* 不传 onSubmit：分支搜索是输入即过滤，没有"提交"这一步 */}
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Branch or tag"
          ariaLabel="搜索分支或标签"
          testId="pm-branch-search"
        />
      </PanelToolbar>
      <div role="tree" className="pm-tree-scroll">
        <BranchGroup label={`HEAD (${headName})`} list={headList} prefix="HEAD " {...rowProps} />
        <LocalGroup list={filtered.filter(n => n.type === 'local')} {...rowProps} />
        <RemoteGroups branches={filtered.filter(n => n.type === 'remote')} {...rowProps} />
        <BranchGroup label="Tags" list={filtered.filter(n => n.type === 'tag')} {...rowProps} />
        {nodes.length === 0 && <EmptyState text="正在检测仓库…" />}
        {/* 过滤后没有任何命中（query 为空时 filtered 恒等于 nodes，不会走到这里） */}
        {nodes.length > 0 && filtered.length === 0 && <EmptyState text="无匹配分支" testId="pm-branches-empty" />}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {label: 'Checkout', disabled: true, reason: '本窗口不支持 Checkout'},
            {label: 'Copy name', onClick: () => void navigator.clipboard.writeText(menu.node.name)},
            {label: 'Copy revision number', onClick: () => void navigator.clipboard.writeText(menu.node.hash)},
            {label: 'Compare with HEAD', disabled: !selectedHash, reason: '需先在 Commit 列表选中一个 commit'},
          ]}
        />
      )}
    </PanelCard>
  )
}
