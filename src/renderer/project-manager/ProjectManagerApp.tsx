import {useEffect, useState, type ReactNode} from 'react'
import {useWorkspaceStore} from './stores/workspaceStore'
import {useGitStatusStore} from './stores/gitStatusStore'
import {useGitLogStore} from './stores/gitLogStore'
import {useEditorTabStore} from './stores/editorTabStore'
import {useFileTreeStore, ROOT_KEY} from './stores/fileTreeStore'
import {FileTree} from './components/FileTree'
import {EditorArea} from './components/EditorArea'
import {QuickOpen} from './components/QuickOpen'
import {GitStatusPanel} from './components/GitStatusPanel'
import {GitLogPanel} from './components/GitLogPanel'
import {StatusBar} from './components/StatusBar'
import {SplitPane} from './ui/SplitPane'
import {PaneRow} from './ui/PaneRow'
import {PanelCard} from './ui/PanelCard'
import {PanelHeader} from './ui/PanelHeader'
import {usePaneSize, GIT_HEIGHT_KEY, COLLAPSED_GIT_HEIGHT, type PaneSizeSpecs} from './hooks/usePaneSize'
import {usePaneOrder, type PaneId} from './hooks/paneOrder'
import {useQuickOpen} from './hooks/useQuickOpen'
import {useThemeSync} from '../lib/theme'
import WindowTitleBar from '../components/common/WindowTitleBar'
import ConfirmDialog from '../components/ConfirmDialog'
import TooltipPortal from '../components/common/TooltipPortal'
import {SendToConversationProvider} from './ui/SendToConversationProvider'
import {basename} from './lib/wsPath'

/** 目录结构变更 → 父目录原地重取的去抖时长（watcher 推送未去抖，持续写入期间只重取一次） */
const FILE_TREE_REFRESH_DEBOUNCE_MS = 300

// 模块级常量：specs 引用必须稳定，usePaneSize 内部用 ref 读取
// 下区的 branches / detail 两个键由 Task 14 的 GitLogPanel 自持实例管理，此实例不碰
const PANE_SPECS: PaneSizeSpecs = {
  fileTree: {default: 200, min: 140, max: 420},
  changes: {default: 210, min: 200, max: 420},
  [GIT_HEIGHT_KEY]: {default: 236, min: 120, max: 100000},
}

/** 窗口高 60% 与 spec.max 取小（spec §5.2） */
function gitMaxHeight(): number {
  return Math.max(PANE_SPECS[GIT_HEIGHT_KEY].min, Math.min(600, Math.round(window.innerHeight * 0.6)))
}

export function ProjectManagerApp() {
  useThemeSync()
  const ws = useWorkspaceStore(s => s.workspacePath)
  const refresh = useGitStatusStore(s => s.refresh)
  const applyPushed = useGitStatusStore(s => s.applyPushed)
  const loadInitial = useGitLogStore(s => s.loadInitial)
  const [branchName, setBranchName] = useState('')

  // 本实例是 gitHeight 键的 owner，因此也是唯一允许调 setGitCollapsed 的实例
  const {sizes, gitCollapsed, commitSize, setGitCollapsed} = usePaneSize(ws, PANE_SPECS)
  // 上半区三列顺序（按 workspace 分键持久化）。与 sizes 共用一条记录但各自 patch 自己的键
  const {order, commitOrder} = usePaneOrder(ws)
  const summary = useGitStatusStore(s => s.summary)
  const gitMax = gitMaxHeight()
  // 折叠高度必须从 gitCollapsed 推导，不能读 sizes[GIT_HEIGHT_KEY]：
  // 折叠态重载后 readPaneLayout 会把存的 22 夹到 spec.min(120)，sizes 在此场景是错的
  const gitHeight = gitCollapsed ? COLLAPSED_GIT_HEIGHT : Math.min(sizes[GIT_HEIGHT_KEY], gitMax)
  const changedCount = summary ? Object.keys(summary.statusMap).length : 0

  // QuickOpen：本窗口唯一的 capture 阶段 document keydown 宿主（独立于主窗口的 shortcutManager）。
  // 传入 ws：Recent Files 的 MRU 按工作区分键、File Search 走 `pm.searchFiles(ws, …)`，切换工作区即整体失效
  const quickOpen = useQuickOpen(ws)

  // 与 StatusBar / GitStatusPanel 同源：changedCount 数 statusMap 全量（含未跟踪 ??）。
  // git diff --numstat HEAD 不含未跟踪文件，只看 additions/deletions 会让"纯未跟踪"工作区
  // 在头部显示 Working tree clean、状态栏却显示 N files changed，两个面自相矛盾。
  const gitSummary = summary && changedCount > 0
    ? `已更改 ${changedCount} 个文件 · +${summary.additions} · −${summary.deletions}`
    : '工作区干净'

  // refsVersion：commit/push 后自增，驱动分支名重新拉取（不放在主 effect 里，
  // 否则每次 bumpRefs 都会连带重跑 refresh / loadInitial / 订阅重建）
  const refsVersion = useGitStatusStore(s => s.refsVersion)
  useEffect(() => {
    const pm = window.electronAPI?.projectManager
    if (!ws || !pm) return
    let cancelled = false
    void pm.gitBranches(ws).then(nodes => {
      if (cancelled || useWorkspaceStore.getState().workspacePath !== ws) return
      setBranchName(nodes.find(n => n.isCurrent)?.name ?? '')
    })
    return () => { cancelled = true }
  }, [ws, refsVersion])

  useEffect(() => {
    const pm = window.electronAPI?.projectManager
    if (!ws || !pm) return
    // 归属守卫：切换 ws 触发 cleanup 置 cancelled；异步回调落地前再显式比对当前 ws（沿用 pushedWs === ws 风格）
    let cancelled = false
    void refresh(ws)
    void loadInitial(ws)
    // dev-only 内存水位监控（复用 2026-08-24 泄漏诊断基建，经 windowFactory [mem-watermark] 链路落盘）
    void import('../utils/memoryWatermark').then(m => m.startWatermarkTimer())
    const offStatus = pm.onStatusChanged((pushedWs, summary) => {
      if (pushedWs === ws) applyPushed(pushedWs, summary as never)
    })
    // 外部 commit / push（LLM、终端）只改 .git，工作区无文件事件：主进程补推 refs 变化，
    // 这里把提交后的刷新面（变更列表 → 分支树 / Git 区头部）整体重取一遍。
    // commit 列表不在此处直接重取（那会在用户翻到历史深处时把列表内容悄悄换掉、打断阅读）：
    // 改为置「待刷新增量」标记，由 GitDagGraph 在用户处于顶部时消费刷新（见 gitLogStore.pendingHeadRefresh）。
    const offRefs = pm.onRefsChanged((pushedWs) => {
      if (pushedWs !== ws) return
      // gitStatusStore.refresh 不吞错：这里必须 catch，否则推送失败会变成 unhandled rejection
      void refresh(ws).catch(() => {})
      useGitLogStore.getState().markHeadRefresh()
      useGitStatusStore.getState().bumpRefs()
    })
    // 外部变更 → file tab 静默重载，按 tab 维度 500ms 防抖（spec §3.4 / §4.2.2）
    const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
    // 文件树刷新：按「受影响的父目录」维度 300ms 防抖，原地重取（绝不删缓存 → 不出现骨架屏）
    const treeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const scheduleDirRefresh = (dir: string) => {
      const pending = treeRefreshTimers.get(dir)
      if (pending) clearTimeout(pending)
      treeRefreshTimers.set(dir, setTimeout(() => {
        treeRefreshTimers.delete(dir)
        const st = useFileTreeStore.getState()
        // 期间切了仓库则放弃
        if (st.ws !== ws) return
        // 需要补载/刷新的目录 = 已缓存目录 ∪ expanded ∪ 根 '.'。
        // - 已缓存：原来的「已加载目录原地重取」。
        // - expanded：兜住「被 LRU 驱逐（CACHE_LIMIT）却仍处于展开态」的目录——渲染只读
        //   childrenCache 且不会刷新 LRU 顺序，这类目录一旦被淘汰就会永久空渲染、任何 watcher
        //   事件都不再自愈。此处命中 expanded 即重新补载（等价旧 tick-effect 的补齐语义，勿删）。
        // - 根 '.'：整棵树的渲染前提，缺失时也补（同旧语义）。
        // 三者皆非（未加载且未展开的目录）才跳过：交给展开时的懒加载。
        const known = st.childrenCache[dir] !== undefined || st.expanded.has(dir) || dir === ROOT_KEY
        if (!known) return
        void pm.listDirectory(ws, dir).then(entries => {
          if (cancelled || useWorkspaceStore.getState().workspacePath !== ws) return
          useFileTreeStore.getState().setChildren(dir, entries, ws)   // 原地替换，不删缓存
        }).catch(() => {})
      }, FILE_TREE_REFRESH_DEBOUNCE_MS))
    }
    const offFile = pm.onFileChanged((pushedWs, payload) => {
      if (pushedWs !== ws) return
      const parentDir = payload.path.split('/').slice(0, -1).join('/') || '.'
      if (payload.type !== 'change') {
        // 目录结构变化才需要重取父目录；'change' 只改文件内容，不影响目录条目，完全不触碰文件树
        if (payload.type === 'unlinkDir') useFileTreeStore.getState().dropSubtree(payload.path)
        scheduleDirRefresh(parentDir)
      }
      // 删除（文件 / 目录）→ 关闭对应的残留标签页（外部删文件也能自动清理）
      if (payload.type === 'unlink' || payload.type === 'unlinkDir') {
        useEditorTabStore.getState().closeTabsForPaths(payload.path)
      }
      const {tabs, reloadTabContent} = useEditorTabStore.getState()
      // ① 只处理 filePath === payload.path 的 tab（不遍历全部 file tab）
      for (const t of tabs.filter(t => t.type === 'file' && t.filePath === payload.path)) {
        const pending = reloadTimers.get(t.id)
        if (pending) clearTimeout(pending)
        reloadTimers.set(t.id, setTimeout(() => {
          // 取最新 tab 快照（防抖期间 tab 可能被关闭或 hash 已被其他链路刷新）
          const cur = useEditorTabStore.getState().tabs.find(x => x.id === t.id)
          if (!cur) return
          // ② readFile promise 补 .catch（虚拟路径 ENOENT 不再 unhandled rejection）
          void pm.readFile(ws, cur.filePath!).then(r => {
            // 归属守卫：期间切了 workspace / 组件已卸载 → 不把旧仓库内容写进新仓库
            if (cancelled || useWorkspaceStore.getState().workspacePath !== ws) return
            if (r.hash && r.hash !== cur.fileHash) reloadTabContent(cur.id, r.content ?? '', r.hash)
          }).catch(() => {})
        }, 500))
      }
    })
    return () => {
      cancelled = true
      offStatus(); offRefs(); offFile()
      for (const timer of reloadTimers.values()) clearTimeout(timer)
      for (const timer of treeRefreshTimers.values()) clearTimeout(timer)
    }
  }, [ws])

  // 面板内容在外层构造并保持 element 身份：换序时 PaneRow 只移动 DOM 节点，不重建这些子树
  const panes: Record<PaneId, ReactNode> = {
    fileTree: <FileTree />,
    editor: <PanelCard testId="pm-card-editor"><EditorArea /></PanelCard>,
    changes: <GitStatusPanel workspace={ws} />,
  }

  return (
    <SendToConversationProvider>
      <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
      {/* 编辑器仍只读（editable=false）；Git 写操作已开放 Add / RM --cached / Commit / Push；Checkout 仍禁用
          （见 CodeEditor.tsx / GitBranchTree.tsx / GitCommitDetail.tsx）。
          标题保留「(只读)」后缀：语义是「编辑器只读查看」，不是「窗口无写能力」。
          无工作区时不加后缀：此时没有项目名，标题只是窗口用途。 */}
      <WindowTitleBar title={ws ? `${basename(ws)} (只读)` : '项目管理'} subtitle={ws} />
      <div className="flex-1 min-h-0 overflow-hidden">
        {!ws ? (
          <div className="pm-no-workspace">未指定项目</div>
        ) : (
          <div className="pm-canvas">
            <SplitPane
              axis="y"
              fixed="second"
              size={gitHeight}
              min={gitCollapsed ? COLLAPSED_GIT_HEIGHT : PANE_SPECS[GIT_HEIGHT_KEY].min}
              max={gitMax}
              onResizeEnd={px => commitSize(GIT_HEIGHT_KEY, px)}
              label="Git 区高度"
              testId="pm-split-git"
              first={
                // 上半区：扁平三列（列顺序可拖动交换）。原来两层嵌套 SplitPane 会让顺序变化变成
                // 不同的 JSX 结构 → 面板子树整棵 remount，故改为 key={paneId} 的扁平列。
                <PaneRow
                  order={order}
                  sizes={sizes}
                  specs={PANE_SPECS}
                  onResizeEnd={commitSize}
                  onReorder={commitOrder}
                  testId="pm-pane-row"
                  panes={panes}
                />
              }
              second={
                <div className="pm-git-zone">
                  <PanelHeader
                    title={branchName ? `Git  ${branchName}` : 'Git'}
                    expanded={!gitCollapsed}
                    onToggle={() => setGitCollapsed(!gitCollapsed)}
                    actions={<span className="pm-git-zone-summary">{gitSummary}</span>}
                    testId="pm-git-header"
                  />
                  {!gitCollapsed && (
                    <div className="pm-git-zone-body">
                      <GitLogPanel />
                    </div>
                  )}
                </div>
              }
            />
            <StatusBar branchName={branchName} />
          </div>
        )}
      </div>
      {/* QuickOpen 浮层：条件渲染 → 关闭即整棵卸载（无残留 DOM / 无残留浮层内监听器） */}
      {quickOpen.mode !== null && (
        <QuickOpen
          mode={quickOpen.mode}
          query={quickOpen.query}
          onQueryChange={quickOpen.setQuery}
          results={quickOpen.results}
          activeIndex={quickOpen.activeIndex}
          loading={quickOpen.loading}
          truncated={quickOpen.truncated}
          error={quickOpen.error}
          stalePaths={quickOpen.stalePaths}
          onActivate={quickOpen.activateIndex}
          onClearRecent={quickOpen.clearRecent}
          onKeyDown={quickOpen.onKeyDown}
          onCompositionStart={quickOpen.onCompositionStart}
          onCompositionEnd={quickOpen.onCompositionEnd}
          workspacePath={ws}
          findFolds={quickOpen.findFolds}
          loadingMore={quickOpen.loadingMore}
          onListScroll={quickOpen.onListScroll}
        />
      )}
      {/* 命令式 confirm() 需要有一个挂载中的实例才会 resolve（编辑区/变更列表共用） */}
      <ConfirmDialog />
      {/* TooltipPortal：PM 窗口内的 [title] 全部由它接管，渲染主题化 tooltip 并突破
          overflow 容器裁剪；否则退回 Windows 原生白条黑字 tooltip（spec §13.7）。
          挂在 ProjectManagerApp 而非 main.tsx：main.tsx 不在测试渲染路径上，挂这里才有回归护栏。 */}
      {typeof document !== 'undefined' && <TooltipPortal />}
      </div>
    </SendToConversationProvider>
  )
}
