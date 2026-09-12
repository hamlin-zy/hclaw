import {useEffect, useState} from 'react'
import {useWorkspaceStore} from './stores/workspaceStore'
import {useGitStatusStore} from './stores/gitStatusStore'
import {useGitLogStore} from './stores/gitLogStore'
import {useEditorTabStore} from './stores/editorTabStore'
import {useFileTreeStore} from './stores/fileTreeStore'
import {FileTree} from './components/FileTree'
import {EditorArea} from './components/EditorArea'
import {GitStatusPanel} from './components/GitStatusPanel'
import {GitLogPanel} from './components/GitLogPanel'
import {StatusBar} from './components/StatusBar'
import {SplitPane} from './ui/SplitPane'
import {PanelCard} from './ui/PanelCard'
import {PanelHeader} from './ui/PanelHeader'
import {usePaneSize, GIT_HEIGHT_KEY, COLLAPSED_GIT_HEIGHT, type PaneSizeSpecs} from './hooks/usePaneSize'
import {useThemeSync} from '../lib/theme'
import WindowTitleBar from '../components/common/WindowTitleBar'
import ConfirmDialog from '../components/ConfirmDialog'
import TooltipPortal from '../components/common/TooltipPortal'
import {SendToConversationProvider} from './ui/SendToConversationProvider'

// workspace 基名（跨平台：兼容 \ 与 /）
const basename = (ws: string) => ws.split(/[\\/]/).filter(Boolean).pop() || ws

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
  const summary = useGitStatusStore(s => s.summary)
  const gitMax = gitMaxHeight()
  // 折叠高度必须从 gitCollapsed 推导，不能读 sizes[GIT_HEIGHT_KEY]：
  // 折叠态重载后 readPaneLayout 会把存的 22 夹到 spec.min(120)，sizes 在此场景是错的
  const gitHeight = gitCollapsed ? COLLAPSED_GIT_HEIGHT : Math.min(sizes[GIT_HEIGHT_KEY], gitMax)
  const changedCount = summary ? Object.keys(summary.statusMap).length : 0

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
    const offFile = pm.onFileChanged((pushedWs, payload) => {
      if (pushedWs !== ws) return
      useFileTreeStore.getState().invalidateFrom(payload.path.split('/').slice(0, -1).join('/') || '.')
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
    }
  }, [ws])

  return (
    <SendToConversationProvider>
      <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
      {/* 编辑器仍只读（editable=false）；Git 写操作已开放 Add / RM --cached / Commit / Push；Checkout 仍禁用
          （见 CodeEditor.tsx / GitBranchTree.tsx / GitCommitDetail.tsx）。
          标题保留「(只读)」后缀：语义是「编辑器只读查看」，不是「窗口无写能力」。
          无工作区时不加后缀：此时没有项目名，标题只是窗口用途。 */}
      <WindowTitleBar title={ws ? `${basename(ws) || '项目管理'} (只读)` : '项目管理'} subtitle={ws} />
      <div className="flex-1 min-h-0 overflow-hidden">
        {!ws ? (
          <div className="pm-no-workspace">未指定工作目录</div>
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
                <SplitPane
                  axis="x"
                  fixed="first"
                  size={sizes.fileTree}
                  min={PANE_SPECS.fileTree.min}
                  max={PANE_SPECS.fileTree.max}
                  onResizeEnd={px => commitSize('fileTree', px)}
                  label="文件树宽度"
                  testId="pm-split-tree"
                  first={<FileTree />}
                  second={
                    <SplitPane
                      axis="x"
                      fixed="second"
                      size={sizes.changes}
                      min={PANE_SPECS.changes.min}
                      max={PANE_SPECS.changes.max}
                      onResizeEnd={px => commitSize('changes', px)}
                      label="变更列表宽度"
                      testId="pm-split-changes"
                      first={<PanelCard testId="pm-card-editor"><EditorArea /></PanelCard>}
                      second={<GitStatusPanel workspace={ws} />}
                    />
                  }
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
