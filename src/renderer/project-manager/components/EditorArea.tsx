import {useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {ChevronDown, ChevronUp} from 'lucide-react'
import {useEditorTabStore} from '../stores/editorTabStore'
import {useWorkspaceStore} from '../stores/workspaceStore'
import {EditorTab} from './EditorTab'
import {CodeEditor, type CodeEditorHandle} from './CodeEditor'
import {DiffViewer} from './DiffViewer'
import {ImageViewer} from './ImageViewer'
import {MarkdownPreview} from './MarkdownPreview'
import type {DiffSelectionSnapshot, DiffViewMode} from './DiffViewer'
import {ContextMenu, type ContextMenuItem} from '../ui/ContextMenu'
import {useSendToConversation} from '../ui/SendToConversationProvider'
import {IconButton} from '../ui/IconButton'
import {usePaneReorderOptional} from '../hooks/usePaneReorder'
import {ToggleChip} from '../ui/ToggleChip'
import {EmptyState} from '../ui/EmptyState'
import {computeTabScrollLeft} from '../utils/tabScroll'
import {toAbsoluteFilePath} from '../utils/mdImageSrc'
import {useLocateRequestStore} from '../stores/locateRequestStore'
import {
  LOCATE_HIGHLIGHT_MS,
  isLocateTargetForActiveFile,
  planLocate,
  type LocateTarget,
} from '../lib/locateHighlight'

const VIM_SIZE_THRESHOLD = 1024 * 1024   // >1MB 走 CodeMirror vim 模式（性能护栏）

/** 视图模式三按钮（spec §12.1）：ToggleChip 用 active 表达「当前模式」 */
const VIEW_MODES: ReadonlyArray<{mode: DiffViewMode, label: string}> = [
  {mode: 'side-by-side', label: '并排'},
  {mode: 'inline', label: '内联'},
  {mode: 'unified', label: '统一'},
]

/** Markdown 视图模式（spec：源码栏只读，不做编辑模式） */
type MdViewMode = 'split' | 'preview'

/** md 视图切换器（与 diff 的 VIEW_MODES 同款 ToggleChip 范式，默认分屏） */
const MD_VIEW_MODES: ReadonlyArray<{mode: MdViewMode, label: string}> = [
  {mode: 'split', label: '分屏'},
  {mode: 'preview', label: '预览'},
]

/** .md / .markdown（忽略大小写）。只看扩展名，不做内容嗅探 */
function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

export function EditorArea() {
  // 面板换序把手（标签栏右侧空白区）。隔离渲染（无 PaneRow 上下文）时为 null → 不渲染 gutter
  const reorder = usePaneReorderOptional()
  const {tabs, activeTabId, reloadTabContent, openDiffTab, setActive} = useEditorTabStore()
  const ws = useWorkspaceStore(s => s.workspacePath)
  const active = tabs.find(t => t.id === activeTabId)
  const [viewMode, setViewMode] = useState<DiffViewMode>('side-by-side')
  const [navSignal, setNavSignal] = useState<{dir: 'prev' | 'next', n: number} | null>(null)
  const navCounter = useRef(0)
  const [mdViewMode, setMdViewMode] = useState<MdViewMode>('split')
  const [diffLoadFailed, setDiffLoadFailed] = useState(false)
  // 「已打开文件」下拉：ContextMenu 是 position:fixed → 用触发器的视口坐标
  const [picker, setPicker] = useState<{x: number, y: number} | null>(null)

  // 「发送到会话」右键宿主：选区固化到 tabId（菜单弹出后用户仍可能切 tab，不能被 activeTabId 漂移污染）
  const sendToConversation = useSendToConversation()
  const [selectionSnapshot, setSelectionSnapshot] = useState<{tabId: string, lineNumbers: number[]} | null>(null)
  const [selectionMenu, setSelectionMenu] = useState<{x: number, y: number} | null>(null)

  /** CodeEditor 选区：CodeMirror 行号即新版本行号，恒可发送 */
  const onEditorSelection = useCallback((sel: {lineNumbers: number[]} | null) => {
    if (!activeTabId) return
    setSelectionSnapshot(sel?.lineNumbers.length
      ? {tabId: activeTabId, lineNumbers: sel.lineNumbers}
      : null)
  }, [activeTabId])

  /** DiffViewer 选区：只接受可发送的快照（旧版本行 / 删除行一律丢弃） */
  const onDiffSelection = useCallback((sel: DiffSelectionSnapshot | null) => {
    if (!activeTabId) return
    setSelectionSnapshot(sel?.sendable
      ? {tabId: activeTabId, lineNumbers: sel.lineNumbers}
      : null)
  }, [activeTabId])

  const pickerRef = useRef<HTMLDivElement | null>(null)
  const tabScrollRef = useRef<HTMLDivElement | null>(null)

  // >5MB 占位 tab 约定：content '' + fileHash ''（fileOpenGate 生成），不进编辑器、不判 forceVim
  const isPlaceholder = active?.type === 'file' && active.content === '' && active.fileHash === ''
  const isImage = active?.type === 'file' && typeof active.content === 'string' && active.content.startsWith('data:image/')
  // forceVim 仅对真实 file tab：排除占位态，1MB < size <= 5MB（>5MB 已在入口被门控拦截）
  const realSize = active?.size ?? active?.content?.length ?? 0
  const forceVim = active?.type === 'file' && !isPlaceholder && !isImage && realSize > VIM_SIZE_THRESHOLD
  // 大 content 淘汰（content===undefined 且 fileHash 存在）→ 静默回填（Task 10 淘汰机制的另一半）
  const evicted = active?.type === 'file' && active.content === undefined && active.fileHash !== undefined
  // md 预览里图片相对路径的解析基准。active.filePath 是**工作区相对路径**（见
  // toAbsoluteFilePath 注释），必须拼回绝对路径，否则相对图仍是 404。
  const mdBasePath = toAbsoluteFilePath(active?.filePath ?? '', ws) || undefined
  // md 视图只对「真实 file tab、非占位、非图片、非淘汰中、且有 content」生效：
  // 与下方 CodeEditor 分支的门控条件保持同一组，不改变其它分支的既有行为。
  const isMarkdown = active?.type === 'file'
    && !evicted && !isPlaceholder && !isImage
    && active.content !== undefined
    && isMarkdownPath(active.filePath ?? active.title)
  useEffect(() => {
    const pm = window.electronAPI?.projectManager
    if (!evicted || !ws || !active?.filePath || !pm) return
    let cancelled = false
    void pm.readFile(ws, active.filePath).then(r => {
      if (cancelled) return
      reloadTabContent(active.id, r.content ?? '', r.hash || active.fileHash || '')
    }).catch(() => {})
    return () => { cancelled = true }
  }, [evicted, ws, active?.id, active?.filePath])

  // 大 diff 淘汰（diffData===undefined 但 tab 保留 filePath/ref/diffType）→ 重新拉取回填
  // 与 file content 回填等价：直接点击 tab 条激活被淘汰的 diff tab 也不会白屏
  const evictedDiff = active?.type === 'diff' && active.diffData === undefined && active.filePath !== undefined
  useEffect(() => {
    setDiffLoadFailed(false)
    const pm = window.electronAPI?.projectManager
    if (!evictedDiff || !ws || !active?.filePath || !pm) return
    let cancelled = false
    // 还原原始拉取参数：working-tree 走默认模式；commit 的 ref 可能是 '<hash>' 或 '<from>..<to>'
    const commitRef = active.diffType === 'commit' ? active.ref : undefined
    let mode: {ref?: string, from?: string, to?: string} | undefined
    if (commitRef) {
      const [from, to] = commitRef.split('..')
      mode = to ? {from, to} : {ref: commitRef}
    }
    void pm.gitDiffFile(ws, active.filePath, mode).then(diffData => {
      if (cancelled) return
      // 复用 openDiffTab 既有去重分支：命中同一 tab → 回填 diffData（不新建 tab、不新增 store 对外 API）
      openDiffTab({filePath: active.filePath!, title: active.title, diffType: active.diffType ?? 'working-tree', ref: active.ref, diffData})
    }).catch(() => { if (!cancelled) setDiffLoadFailed(true) })
    return () => { cancelled = true }
  }, [evictedDiff, ws, active?.id, active?.filePath, active?.ref])

  // 激活 tab 变化时把它滚入可视区。以 activeTabId 为唯一触发点，收敛所有激活入口：
  // 点击 tab、右侧「已打开文件」下拉、双击文件树/Git Status 新建并激活。避免在各入口分别打补丁。
  // 不用 scrollIntoView：它会连带滚动所有可滚动祖先（可能纵向跳动），且 jsdom 下方法缺失需兜底；
  // 这里只在滚动容器上手动计算并写 scrollLeft（组件不写内联 style，符合测试约定）。
  useEffect(() => {
    const container = tabScrollRef.current
    if (!container || !activeTabId) return
    // 用 data-tab-id 精确定位：tab.title 可能重复或含选择器特殊字符
    const el = container.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)
    if (!el) return
    // jsdom 无布局 → rect 全零 → computeTabScrollLeft 返回原值，effect 静默 no-op
    const next = computeTabScrollLeft(
      container.getBoundingClientRect(),
      el.getBoundingClientRect(),
      container.scrollLeft,
    )
    if (next !== container.scrollLeft) container.scrollLeft = next
  }, [activeTabId])

  // ── 定位（工单 06）：订阅 locateRequestStore，把「打开后落到那一行」应用给当前激活 tab 的编辑器 ──
  // 请求由 QuickOpen 的打开流程发出（工单 05），编辑器侧只做消费方。seq 单调前进，
  // 因此「重复定位到同一行」也能被识别为一次新的定位（契约见 stores/locateRequestStore.ts）。
  const locateSeq = useLocateRequestStore(s => s.seq)
  const locatePath = useLocateRequestStore(s => s.path)
  const locateLine = useLocateRequestStore(s => s.line)
  /** 编辑器句柄；编辑器未挂载时为 null（挂载时机由 EditorArea 的条件渲染决定） */
  const locateEditorRef = useRef<CodeEditorHandle | null>(null)
  /** 编辑器就绪（EditorView 已创建）。视图是异步创建的，请求可能比它先到 */
  const editorReadyRef = useRef(false)
  /** 挂起中的定位请求：编辑器未挂载 / 视图未就绪时在此等候，就绪后由 applyPendingLocate 消费 */
  const pendingLocateRef = useRef<LocateTarget | null>(null)
  /** 上一次已点亮的落点：重复定位同一行时只重置计时、不重新滚动 */
  const lastLocateRef = useRef<LocateTarget | null>(null)
  /** 1500ms 自动硬清除的计时器 */
  const locateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前激活文件路径：回调里同步读取（放进依赖会让每次 tabs 变化都重跑订阅 effect） */
  const activePathRef = useRef<string | null>(null)
  activePathRef.current = active?.filePath ?? null

  const clearLocateTimer = useCallback(() => {
    if (locateTimerRef.current !== null) {
      clearTimeout(locateTimerRef.current)
      locateTimerRef.current = null
    }
  }, [])

  /**
   * 把挂起中的定位请求应用到当前编辑器。三处会调用它：请求到达、编辑器就绪、视图就绪后重试。
   * 未就绪（句柄缺失 / 视图未创建）时**保持挂起**，不丢请求——这正是「请求先到、编辑器后挂载」的处理点。
   */
  const applyPendingLocate = useCallback(() => {
    const req = pendingLocateRef.current
    const handle = locateEditorRef.current
    if (req === null || handle === null || !editorReadyRef.current) return
    // 不属于当前激活文件（切 tab 期间迟到的请求）→ 丢弃，绝不落到新 tab 上
    if (!isLocateTargetForActiveFile(req.path, activePathRef.current)) {
      pendingLocateRef.current = null
      return
    }
    // 视图尚未创建 → locate 返回 false，继续挂起，等 onEditorReady 再来
    if (!handle.locate(req.line, {scroll: planLocate(lastLocateRef.current, req).scroll})) return
    pendingLocateRef.current = null
    lastLocateRef.current = req
    // 1500ms 后硬清除（无渐隐）。再次定位先清旧计时器，从新高亮重新计时。
    clearLocateTimer()
    locateTimerRef.current = setTimeout(() => {
      locateTimerRef.current = null
      locateEditorRef.current?.clearLocate()
    }, LOCATE_HIGHLIGHT_MS)
  }, [clearLocateTimer])

  const onLocateEditorReady = useCallback(() => {
    editorReadyRef.current = true
    applyPendingLocate()
  }, [applyPendingLocate])

  /** CodeEditor 的 ref：挂载/卸载时同步句柄与就绪旗标 */
  const setLocateEditor = useCallback((handle: CodeEditorHandle | null) => {
    locateEditorRef.current = handle
    if (handle !== null) return
    // 编辑器实例销毁（切 tab / md 视图切换 / 关 tab / 淘汰重载）= 高亮的天然清除点：
    // 视图连同其 StateField 一起没了。这里一并作废句柄、就绪旗标、挂起请求、落点记忆与计时器，
    // 避免旧请求 / 旧计时器落到下一个实例上。
    editorReadyRef.current = false
    pendingLocateRef.current = null
    lastLocateRef.current = null
    clearLocateTimer()
  }, [clearLocateTimer])

  // 切 tab：旧高亮随编辑器视图重建天然消失；但计时器与「上一个落点」必须作废——否则回到旧 tab 时
  // 会因「同一落点」判定而跳过滚动，目标行可能不在视口内。挂起请求**不在这里清**：
  // 「打开并定位」是同一个 tick 里先建 tab 再发请求，清理晚于订阅就会把刚到的请求吞掉；
  // 跨 tab 的迟到请求由 applyPendingLocate 里的路径校验拦下。
  useEffect(() => {
    clearLocateTimer()
    lastLocateRef.current = null
  }, [activeTabId, clearLocateTimer])

  // 定位请求到达：只认属于当前激活 tab 的请求，其余丢弃（不挂起到别的 tab）
  useEffect(() => {
    if (locateSeq === 0 || locatePath === null) return
    if (!isLocateTargetForActiveFile(locatePath, activePathRef.current)) return
    pendingLocateRef.current = {path: locatePath, line: locateLine}
    applyPendingLocate()
  }, [locateSeq, locatePath, locateLine, applyPendingLocate])

  // 卸载：计时器不能留着（回调会去碰已销毁的编辑器）
  useEffect(() => clearLocateTimer, [clearLocateTimer])

  const pickerItems: ContextMenuItem[] = tabs.map(t => ({
    label: t.title,
    onClick: () => setActive(t.id),
  }))

  /** 下拉锚定在 picker 按钮左下角（fixed 视口坐标） */
  const openPicker = () => {
    const rect = pickerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPicker({x: rect.left, y: rect.bottom})
  }

  /**
   * 编辑器区右键：仅在「当前 tab 有可发送的行选区」且落点可接管时才接管。
   * Markdown 区只放行源码栏 CodeEditor（.cm-editor），预览区 / 工具栏不接管；
   * 搜索面板同样不接管。其余场景不 preventDefault，放行浏览器默认菜单。
   */
  const onEditorContextMenu = (e: ReactMouseEvent) => {
    if (!(e.target instanceof Element)) return
    if (e.target.closest('.cm-panels')) return                    // CodeMirror 搜索面板
    if (e.target.closest('.pm-md-preview-pane')) return           // 预览模式整面板
    // Markdown 区仅放行源码栏（CodeMirror 根 .cm-editor）；split 右栏预览 / 工具栏不接管
    if (e.target.closest('.pm-md-pane') && !e.target.closest('.cm-editor')) return
    const snap = selectionSnapshot
    if (!snap || snap.tabId !== activeTabId || snap.lineNumbers.length === 0) return
    e.preventDefault()
    setSelectionMenu({x: e.clientX, y: e.clientY})
  }

  /** 菜单仅一项：把选区转成 `lines` 上下文交给 Provider（ContextMenu 点击后会自动 onClose） */
  const selectionMenuItems: ContextMenuItem[] = [{
    label: '发送到会话',
    onClick: () => {
      const snap = selectionSnapshot
      if (!snap) return
      const tab = tabs.find(t => t.id === snap.tabId)
      if (!tab?.filePath) return
      // commit diff 的 ref 可能是 '<hash>' 或 '<from>..<to>'：只有单点 hash 才能当 revision
      const revision = tab.type === 'diff' && tab.diffType === 'commit' && tab.ref && !tab.ref.includes('..')
        ? tab.ref
        : undefined
      sendToConversation?.request({kind: 'lines', filePath: tab.filePath, lineNumbers: snap.lineNumbers, revision})
    },
  }]

  return (
    <div className="pm-editor-area">
      <div className="pm-tabbar">
        {/* 单行不换行：.pm-tab 是 flex: 0 0 auto + nowrap，靠这里横向滚动（spec §2.5） */}
        <div className="pm-tabbar-scroll" role="tablist" ref={tabScrollRef}>
          {tabs.map(t => <EditorTab key={t.id} tab={t} />)}
        </div>
        {/* 编辑区把手 = 标签栏右侧空白区（不新增标题栏）。它是 scroll 的**兄弟**节点、不在 tablist 内、
            不接任何 click 处理器 ⇒ 点 tab / 横向滚动 / hover 完全不变；标签溢出时靠 min-width 保底 14px。 */}
        {reorder && (
          <div
            className="pm-tabbar-drag"
            data-testid="pm-editor-drag-handle"
            onMouseDown={e => reorder.beginDrag('editor', e)}
          />
        )}
        <div className="pm-tabbar-picker" ref={pickerRef} data-testid="editor-tab-picker" onClick={openPicker}>
          {/* label 同时是 aria-label 与 title（IconButton 契约），tooltip 由 TooltipPortal 接管 */}
          <IconButton icon={ChevronDown} label="已打开文件" />
        </div>
      </div>

      <div className="pm-editor-body" onContextMenu={onEditorContextMenu}>
        {!active && <EmptyState text="双击左侧文件树或右侧 Git Status 打开文件" testId="pm-editor-empty" />}
        {active?.type === 'file' && evicted && <div className="pm-editor-note">加载中…</div>}
        {active?.type === 'file' && isImage && <ImageViewer src={active.content!} />}
        {active?.type === 'file' && isPlaceholder && <div className="pm-editor-note">无法预览此文件（过大或二进制）</div>}
        {active?.type === 'file' && isMarkdown && (
          <div className="pm-md-pane">
            <div className="pm-md-toolbar">
              {MD_VIEW_MODES.map(({mode, label}) => (
                <ToggleChip
                  key={mode}
                  label={label}
                  active={mdViewMode === mode}
                  onToggle={() => { if (mdViewMode !== mode) setMdViewMode(mode) }}
                />
              ))}
            </div>
            {mdViewMode === 'split' ? (
              <div className="pm-md-split">
                <div className="pm-md-half" data-testid="md-source-pane">
                  <CodeEditor
                    ref={setLocateEditor}
                    content={active.content!}
                    path={active.filePath ?? ''}
                    forceVim={forceVim}
                    onSelectionChange={onEditorSelection}
                    onEditorReady={onLocateEditorReady}
                  />
                </div>
                <div className="pm-md-half" data-testid="md-preview-pane">
                  <MarkdownPreview content={active.content!} basePath={mdBasePath} />
                </div>
              </div>
            ) : (
              <div className="pm-md-preview-pane">
                <MarkdownPreview content={active.content!} basePath={mdBasePath} />
              </div>
            )}
          </div>
        )}
        {active?.type === 'file' && !evicted && !isPlaceholder && !isImage && !isMarkdown && active.content !== undefined && (
          <CodeEditor
            ref={setLocateEditor}
            content={active.content}
            path={active.filePath ?? ''}
            forceVim={forceVim}
            onSelectionChange={onEditorSelection}
            onEditorReady={onLocateEditorReady}
          />
        )}
        {active?.type === 'diff' && evictedDiff && !diffLoadFailed && <div className="pm-editor-note">加载中…</div>}
        {active?.type === 'diff' && evictedDiff && diffLoadFailed && <div className="pm-editor-note">无法加载此 diff</div>}
        {active?.type === 'diff' && active.diffData && (
          <div className="pm-diff-pane">
            <div className="pm-diff-toolbar">
              {VIEW_MODES.map(({mode, label}) => (
                <ToggleChip
                  key={mode}
                  label={label}
                  active={viewMode === mode}
                  // ToggleChip 无 disabled prop：已激活项早退，保持既有「点当前模式不变」语义
                  onToggle={() => { if (viewMode !== mode) setViewMode(mode) }}
                />
              ))}
              <IconButton icon={ChevronUp} label="上一个差异" onClick={() => setNavSignal({dir: 'prev', n: ++navCounter.current})} />
              <IconButton icon={ChevronDown} label="下一个差异" onClick={() => setNavSignal({dir: 'next', n: ++navCounter.current})} />
            </div>
            <DiffViewer data={active.diffData} viewMode={viewMode} navSignal={navSignal} onSelectionChange={onDiffSelection} />
          </div>
        )}
      </div>

      {picker && (
        <ContextMenu x={picker.x} y={picker.y} items={pickerItems} onClose={() => setPicker(null)} />
      )}
      {selectionMenu && (
        <ContextMenu x={selectionMenu.x} y={selectionMenu.y} items={selectionMenuItems} onClose={() => setSelectionMenu(null)} />
      )}
    </div>
  )
}
