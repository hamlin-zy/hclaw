import {useEffect, useState} from 'react'
import {ArrowDownUp, RefreshCw} from 'lucide-react'
import type {GitAuthor} from '@shared/types/project-manager'
import {useWorkspaceStore} from '../stores/workspaceStore'
import {useGitLogStore} from '../stores/gitLogStore'
import {GitBranchTree} from './GitBranchTree'
import {GitDagGraph} from './GitDagGraph'
import {GitCommitDetail} from './GitCommitDetail'
import {SplitPane} from '../ui/SplitPane'
import {PanelCard} from '../ui/PanelCard'
import {PanelHeader} from '../ui/PanelHeader'
import {PanelToolbar} from '../ui/PanelToolbar'
import {SearchInput} from '../ui/SearchInput'
import {ToggleChip} from '../ui/ToggleChip'
import {IconButton} from '../ui/IconButton'
import {AuthorFilterSelect} from '../ui/AuthorFilterSelect'
import DatePicker from '../../components/common/DatePicker'
import {usePaneSize, type PaneSizeSpecs} from '../hooks/usePaneSize'

/**
 * 过滤栏是 18px 小尺寸（对照 globals.css 的 .pm-commits-input），而 .dp-* 按 12px 默认尺寸书写，
 * 且位于 globals.css 顶部 `@tailwind utilities` 之后——同特异性下后者胜出，普通工具类压不下去，
 * 因此这里用 important 修饰符（`!`）把输入框压到与「作者」「路径」同排一致的尺度：
 * 高 18 / 字号 11 / 行高 16（18 - 2×1px 边框）/ 内边距 0 4px / 圆角 3px / 底色 surface-muted。
 * 边框色沿用 .dp-input 的 var(--border)，与 .pm-commits-input 本就一致，无需覆盖。
 * 日历触发按钮是输入框的相邻兄弟节点，className 只能落在输入框上，故用任意变体 [&+button] 一并缩小，
 * 否则 24×24 的按钮会让整行比同排输入框高出一截。
 */
const DATE_FILTER_INPUT_CLASS = [
  '!h-[18px] !w-[80px] !px-[4px] !py-0 !text-[11px] !leading-[16px] !rounded-[3px] !bg-surface-muted',
  '[&+button]:!h-[18px] [&+button]:!w-[18px] [&+button]:!rounded-[3px]',
  '[&+button_svg]:!h-[11px] [&+button_svg]:!w-[11px]',
].join(' ')

// 模块级常量：specs 引用必须稳定（usePaneSize 内部用 ref 读取）。
// 本实例只管理 branches / detail 两个键——gitHeight 归 ProjectManagerApp 的实例，
// 折叠标志是跨实例 last-writer-wins，因此这里绝不调用 setGitCollapsed（spec §5.2）。
const PANE_SPECS: PaneSizeSpecs = {
  branches: {default: 186, min: 150, max: 380},
  detail: {default: 236, min: 220, max: 480},
}

export function GitLogPanel() {
  const ws = useWorkspaceStore(s => s.workspacePath)
  const loadInitial = useGitLogStore(s => s.loadInitial)
  const applyFilters = useGitLogStore(s => s.applyFilters)
  const entries = useGitLogStore(s => s.entries)
  const [text, setText] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  // Date/Paths/User 过滤（spec §4.4.3 v1 范围）
  const [user, setUser] = useState('')
  const [paths, setPaths] = useState('')
  const [since, setSince] = useState('')   // yyyy-mm-dd
  const [until, setUntil] = useState('')
  const [sortAsc, setSortAsc] = useState(false)   // 排序：前端 entries 倒序切换
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 作者候选（下拉）：仅展开过滤栏时才拉，git shortlog 是真起 git 进程
  const [authors, setAuthors] = useState<GitAuthor[]>([])
  const [authorsLoading, setAuthorsLoading] = useState(false)
  // 读取失败（git 未安装 / 超时 / 权限 / 非仓库等）单列一态：与「仓库暂无作者」区分，避免误导排查
  const [authorsError, setAuthorsError] = useState(false)

  // 懒加载 + 切仓库失效重取。deps 只含 showAdvanced/ws，输入 user 不会触发请求；
  // 失败（非 git 仓库等）降级为空列表并标记错误态，手输框保持可用。
  useEffect(() => {
    if (!showAdvanced || !ws) return
    let cancelled = false
    setAuthorsLoading(true)
    setAuthorsError(false)
    void (async () => {
      try {
        const list = await window.electronAPI?.projectManager.gitAuthors(ws)
        if (!cancelled) {
          setAuthors(list ?? [])
          setAuthorsError(false)
        }
      } catch {
        if (!cancelled) {
          setAuthors([])
          setAuthorsError(true)
        }
      } finally {
        if (!cancelled) setAuthorsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showAdvanced, ws])

  const {sizes, commitSize} = usePaneSize(ws, PANE_SPECS)

  const toDate = (s: string) => s ? new Date(s + 'T00:00:00').getTime() : undefined
  const runFilter = () =>
    void applyFilters(ws, {
      limit: 100,
      filterText: text || undefined,
      filterFlags: {regex, caseSensitive, wholeWord},
      filterUser: user ? user.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      filterPaths: paths ? paths.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      filterDateRange: (since || until) ? [toDate(since) ?? 0, toDate(until) ?? Date.now()] : undefined,
    })

  const commitColumn = (
    <PanelCard testId="pm-commits">
      <PanelHeader title="提交" count={entries.length} testId="pm-commits-header" />
      <PanelToolbar testId="pm-commits-toolbar">
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="文本或哈希"
          ariaLabel="搜索 commit"
          onSubmit={runFilter}
          submitLabel="查找"
        />
        <ToggleChip label=".*" active={regex} onToggle={() => setRegex(v => !v)} title="正则" />
        <ToggleChip label="Cc" active={caseSensitive} onToggle={() => setCaseSensitive(v => !v)} title="区分大小写" />
        <ToggleChip label="Co" active={wholeWord} onToggle={() => setWholeWord(v => !v)} title="全词匹配" />
        <ToggleChip label="筛选" active={showAdvanced} onToggle={() => setShowAdvanced(v => !v)} title="作者 / 路径 / 日期" />
        <IconButton icon={ArrowDownUp} label={sortAsc ? '升序' : '降序'} onClick={() => setSortAsc(v => !v)} />
        <IconButton icon={RefreshCw} label="刷新" onClick={() => void loadInitial(ws)} />
      </PanelToolbar>
      {showAdvanced && (
        <div className="pm-commits-advanced" data-testid="pm-commits-advanced">
          <label className="pm-commits-field">
            作者
            <AuthorFilterSelect
              value={user}
              onChange={setUser}
              authors={authors}
              loading={authorsLoading}
              error={authorsError}
              placeholder="作者，逗号分隔"
              ariaLabel="作者过滤"
            />
          </label>
          <label className="pm-commits-field">
            路径
            <input className="pm-commits-input" value={paths} onChange={e => setPaths(e.target.value)} placeholder="路径，逗号分隔" />
          </label>
          <label className="pm-commits-field">
            起始日期
            <DatePicker
              value={since}
              onChange={setSince}
              ariaLabel="起始日期"
              className={DATE_FILTER_INPUT_CLASS}
            />
          </label>
          <label className="pm-commits-field">
            截止日期
            <DatePicker
              value={until}
              onChange={setUntil}
              ariaLabel="截止日期"
              className={DATE_FILTER_INPUT_CLASS}
            />
          </label>
        </div>
      )}
      <GitDagGraph sortAsc={sortAsc} />
    </PanelCard>
  )

  // 下区三列（spec §5.3）：固定 | 弹性 | 固定，靠嵌套两层 SplitPane 实现。
  // GitBranchTree / GitCommitDetail 各自渲染 PanelCard（Task 15 给详情补卡片），此处不再包一层。
  return (
    <SplitPane
      axis="x"
      fixed="first"
      size={sizes.branches}
      min={PANE_SPECS.branches.min}
      max={PANE_SPECS.branches.max}
      onResizeEnd={px => commitSize('branches', px)}
      label="分支宽度"
      testId="pm-split-branches"
      first={<GitBranchTree />}
      second={
        <SplitPane
          axis="x"
          fixed="second"
          size={sizes.detail}
          min={PANE_SPECS.detail.min}
          max={PANE_SPECS.detail.max}
          onResizeEnd={px => commitSize('detail', px)}
          label="Commit 详情宽度"
          testId="pm-split-detail"
          first={commitColumn}
          second={<GitCommitDetail workspace={ws} />}
        />
      }
    />
  )
}
