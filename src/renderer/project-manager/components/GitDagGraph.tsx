import {memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type UIEvent} from 'react'
import type {GitLogEntry} from '@shared/types/project-manager'
import {useGitLogStore} from '../stores/gitLogStore'
import {useWorkspaceStore} from '../stores/workspaceStore'
import {relativeTime} from '../utils/format'
import {ContextMenu} from '../ui/ContextMenu'
import {useSendToConversation} from '../ui/SendToConversationProvider'
import {modsOf} from '../lib/multiSelect'

/**
 * 触底判定的提前量：48px ≈ 2 行（commit 行高 26px，故略小于 2 行）。
 * 不用 `scrollTop + clientHeight === scrollHeight` 严格相等：触底滚动事件可能因亚像素误差、
 * 惯性滚动或内容高度在滚动中变化而"恰好"错过最后那一帧，留阈值可稳定触发。
 */
const LOAD_MORE_THRESHOLD = 48

interface CommitRowProps {
  entry: GitLogEntry
  selected: boolean
  /** 稳定引用：行内自行解析修饰键（Ctrl/Shift）后回调，父级经 ref 读取最新 displayOrder；
      不要把每次渲染都新建的数组/箭头函数当 prop 传进来，否则 memo 会整体失效 */
  onSelect(hash: string, mods: {ctrl?: boolean, shift?: boolean}): void
  onContextMenu(hash: string, x: number, y: number): void
  /** 键盘导航（ArrowUp/Down、Home/End、Enter/Space）：父级持有 entries 显示顺序，故导航在父级处理 */
  onRowKeyDown(hash: string, ev: KeyboardEvent<HTMLDivElement>): void
  /** roving tabindex 的 Tab 入口行（布尔原始值，memo 比对安全） */
  tabbable: boolean
}

/**
 * 单行 commit（四段式，spec §9.1）：rail / hash / subject / refs / author · 相对时间。
 * React.memo：loadMore 追加新页时旧行的 entry 引用不变、selected 不变、回调稳定 → 跳过重渲染；
 * 否则每翻一页都会把已加载的上千行重新渲染一遍。
 */
const CommitRow = memo(function CommitRow({entry: e, selected, tabbable, onSelect, onContextMenu, onRowKeyDown}: CommitRowProps) {
  const isMerge = e.parents.length > 1
  const refs = [
    ...(e.isHead ? [{key: 'HEAD', text: 'HEAD'}] : []),
    ...e.tags.map(t => ({key: `tag:${t}`, text: `tag:${t}`})),
    ...e.branches.map(b => ({key: `branch:${b}`, text: b})),
  ]
  return (
    <div
      className={selected ? 'pm-commit-row is-selected' : 'pm-commit-row'}
      data-testid="pm-commit-row"
      role="treeitem"
      aria-selected={selected}
      aria-label={`${e.abbreviatedHash} ${e.message}`}
      title={e.message}
      // roving tabindex：Tab 进列表落在「当前行」（tabbable），其余行 -1。
      // 无选中行时必须仍有一个 0，否则整个列表不可 Tab 进入（方向键无从起步）。
      // 行内键盘（ArrowUp/Down、Home/End、Enter/Space）由父级 onRowKeyDown 统一处理。
      tabIndex={tabbable ? 0 : -1}
      onKeyDown={ev => onRowKeyDown(e.hash, ev)}
      // 行是 <div>（不是 <button>），行内文本默认可被浏览器原生选区选中：单击把 caret 落进行内即成为
      // selection anchor，之后的 Shift+单击触发原生「扩展选区」→ 视觉上出现一段被选中的文字。
      // 列表行是选择控件、文本本就不该可选（.pm-tree-row 因用 <button> 天然免疫），故左键按下即抑制
      // 原生文本选择（与 DiffViewer.startSelect 同口径）；右键放行，交给 onContextMenu 弹菜单。
      onMouseDown={ev => {
        if (ev.button !== 0) return
        ev.preventDefault()
      }}
      onClick={ev => {
        if (ev.detail > 1) return
        onSelect(e.hash, modsOf(ev))
      }}
      onContextMenu={ev => {
        ev.preventDefault()
        ev.stopPropagation()
        onContextMenu(e.hash, ev.clientX, ev.clientY)
      }}
    >
      {/* DAG 轨道（spec §9.3 单列简化）：1.5px 竖线 + 7px 圆点 */}
      <span className="pm-commit-rail" aria-hidden="true">
        <span className="pm-commit-rail-line" />
        <span className={`pm-commit-rail-dot${isMerge ? ' is-merge' : ''}${e.isHead ? ' is-head' : ''}`} />
      </span>
      <span className="pm-commit-hash">{e.abbreviatedHash}</span>
      <span className="pm-commit-subject">{e.message}</span>
      <span className="pm-commit-refs">
        {refs.map(r => (
          <span key={r.key} className="pm-ref-badge">{r.text}</span>
        ))}
      </span>
      <span className="pm-commit-meta">{e.author} · {relativeTime(e.authorDate)}</span>
    </div>
  )
})

export function GitDagGraph({sortAsc = false}: {sortAsc?: boolean}) {
  const rawEntries = useGitLogStore(s => s.entries)
  const selectedHash = useGitLogStore(s => s.selectedHash)
  const select = useGitLogStore(s => s.select)
  const selectWithMods = useGitLogStore(s => s.selectWithMods)
  const selectedHashes = useGitLogStore(s => s.selectedHashes)
  const sendToConversation = useSendToConversation()
  const [menu, setMenu] = useState<{x: number, y: number, hash: string} | null>(null)
  const loadMore = useGitLogStore(s => s.loadMore)
  const loadInitial = useGitLogStore(s => s.loadInitial)
  const hasMore = useGitLogStore(s => s.hasMore)
  const loading = useGitLogStore(s => s.loading)
  const pendingHeadRefresh = useGitLogStore(s => s.pendingHeadRefresh)
  const consumeHeadRefresh = useGitLogStore(s => s.consumeHeadRefresh)
  const ws = useWorkspaceStore(s => s.workspacePath)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 触底加载是否「已武装」：触发一次后置 false，滚离底部阈值区间才重新置 true（见 onScroll 注释） */
  const armedRef = useRef(true)
  // 切仓库会整体换掉列表，旧仓库遗留的「未武装」状态不应带进新仓库
  useEffect(() => { armedRef.current = true }, [ws])
  // 前端排序：默认按 store 原序（新→旧），sortAsc 时倒序显示（数据不变，仅展示）
  const entries = sortAsc ? [...rawEntries].reverse() : rawEntries
  /** 显示顺序（sortAsc 时已倒序）——Shift 区间选必须用这个顺序 */
  const displayOrder = entries.map(e => e.hash)
  /**
   * roving tabindex 的 Tab 入口行：优先当前选中行；用户从未点选过（selectedHash 为 null）或选中行
   * 已不在当前列表（如被过滤掉）时退化为首行。若无此退化，所有行 tabIndex=-1 且 role="tree" 容器
   * 本身不可聚焦 → 键盘用户根本无法进入该列表，方向键也无从起步。
   */
  const focusableHash = entries.some(e => e.hash === selectedHash) ? selectedHash : entries[0]?.hash
  // displayOrder 用 ref 承载最新值：行组件的 onSelect 必须是稳定引用（memo 前提），
  // 但 Shift 区间选要基于「当前」显示顺序，因此在点击时刻经 ref 读取，而不是把数组当 prop 传。
  const displayOrderRef = useRef(displayOrder)
  displayOrderRef.current = displayOrder

  const handleSelect = useCallback((hash: string, mods: {ctrl?: boolean, shift?: boolean}) => {
    selectWithMods(hash, displayOrderRef.current, mods)
  }, [selectWithMods])

  /**
   * 行内键盘导航。roving tabindex 决定 Tab 入口，这里处理行内的方向键/Home/End/Enter/Space。
   * - ArrowUp/Down、Home/End：在**显示顺序**上移动，并按「移动即选中」调用既有选中通路（与鼠标单击同语义）；
   * - 边界处停在原位（不循环），但仍吞掉按键——行位于可滚动容器内，方向键默认会滚动页面；
   * - Enter/Space：等价鼠标单击，修饰键经 modsOf 解析（Ctrl/Cmd 多选切换、Shift 区间选）。
   */
  const handleRowKeyDown = useCallback((hash: string, ev: KeyboardEvent<HTMLDivElement>) => {
    const order = displayOrderRef.current
    const idx = order.indexOf(hash)
    if (idx < 0) return
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      handleSelect(hash, modsOf(ev))
      return
    }
    let nextIdx: number
    switch (ev.key) {
      case 'ArrowDown': nextIdx = Math.min(idx + 1, order.length - 1); break
      case 'ArrowUp': nextIdx = Math.max(idx - 1, 0); break
      case 'Home': nextIdx = 0; break
      case 'End': nextIdx = order.length - 1; break
      default: return
    }
    ev.preventDefault()
    if (nextIdx === idx) return
    handleSelect(order[nextIdx], {ctrl: false, shift: false})
    // 列表无虚拟化、全量渲染：目标行节点已存在于 DOM，按显示顺序取第 nextIdx 个即可。
    // 限定在 scrollRef 容器内查询（而非 document），避免多实例/弹层里的同名节点干扰。
    const el = scrollRef.current?.querySelectorAll<HTMLElement>('[data-testid="pm-commit-row"]')[nextIdx]
    if (!el) return
    el.scrollIntoView({block: 'nearest'})
    el.focus()
  }, [handleSelect])

  const handleRowContextMenu = useCallback((hash: string, x: number, y: number) => {
    // 右键落在选区外 → 先收敛为单行（保持原语义）
    if (!useGitLogStore.getState().selectedHashes.has(hash)) select(hash)
    setMenu({x, y, hash})
  }, [select])

  /** 消费「待刷新增量」并重取首屏：loadInitial 走 beginRequest 代际守卫并重置 entries，是期望行为 */
  const flushHeadRefresh = useCallback(() => {
    if (consumeHeadRefresh()) void loadInitial(ws)
  }, [consumeHeadRefresh, loadInitial, ws])

  // 标记置位时用户可能已停在顶部（或列表未滚动过，不会有新的 scroll 事件）：
  // 此时立即消费刷新，否则要等用户下次滚动才生效。
  useEffect(() => {
    if (!pendingHeadRefresh) return
    if (scrollRef.current && scrollRef.current.scrollTop <= 0) flushHeadRefresh()
  }, [pendingHeadRefresh, flushHeadRefresh])

  /**
   * 加载更早历史：失败时恢复 armed 并吞掉 rejection。
   * store.loadMore 只有 try/finally 没有 catch，IPC reject 会向外抛；不 catch 就是 unhandled rejection，
   * 且 armed 被提前置 false 后、视口仍贴底时不会再武装 → 永远无法重试。
   */
  const loadMoreSafely = useCallback(() => {
    armedRef.current = false
    void loadMore(ws).catch(() => { armedRef.current = true })
  }, [loadMore, ws])

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    // 原则：**触发端必须与新增内容的插入端同一侧**。
    // loadMore 永远把更早的页 append 到 store 尾部（新→旧序的更早侧）；显示端 sortAsc 时整体 reverse，
    // 于是插入端在降序时是视觉底部、升序时是视觉顶部。触发端若与之相反，会出现两个坏结果：
    // ① 用户在看得见的一侧滚到底，新内容却插到看不见的另一侧；② 滚动锚定维持视口不动、把滚动位置
    // 钉在触发端阈值内 → 无法按「离开阈值」重新武装，每翻一页都得先滚开再滚回来。
    if (sortAsc) {
      // 升序：插入端在顶部 → 用距顶判定；滚离顶部阈值（scrollTop > 48）才重新武装。
      // 触发后 armed=false，而用户仍停在顶部（≤48）、未离开阈值 → 不会连环；滚开再回顶才加载下一页。
      if (el.scrollTop > LOAD_MORE_THRESHOLD) armedRef.current = true
      if (armedRef.current && el.scrollTop <= LOAD_MORE_THRESHOLD && hasMore && !loading) loadMoreSafely()
      return
    }
    // 降序（默认）：插入端在底部 → 用距底判定。
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    // 「重新武装」（re-arm）：触发一次 loadMore 后置为未武装，只有滚动位置离开底部阈值区间才重新武装。
    // 为什么必须有这层约束：追加新页后 Chromium 的滚动锚定（scroll anchoring）会为保持视口不动而
    // 再派发一次 scroll，此时仍满足触底条件——不做 re-arm 就会立刻再次触发，连环翻页直到 MAX_LOG_ENTRIES。
    // 定时器节流只是把它变慢，用户仍会看到列表自己刷到底，故不采用。
    // 用户滚开（距底 > 阈值）再回到底部时，本行重新武装，正常手感保留。
    if (distanceFromBottom > LOAD_MORE_THRESHOLD) armedRef.current = true
    // 顶部：只负责消费「待刷新增量」，不再触发 loadMore（降序下更早的历史在底部那一头）。
    // 刷新后新提交出现在列表最前，视口本来就在顶部，用户正好看到。
    if (el.scrollTop <= 0) {
      flushHeadRefresh()
      return
    }
    // 底部：加载更早历史。armedRef 保证「一次触底只加载一页」
    if (armedRef.current && distanceFromBottom <= LOAD_MORE_THRESHOLD && hasMore && !loading) loadMoreSafely()
  }, [flushHeadRefresh, hasMore, loading, loadMoreSafely, sortAsc])

  return (
    <>
      <div
        role="tree"
        className="pm-commits-scroll"
        ref={scrollRef}
        onScroll={onScroll}
      >
        {entries.map(e => (
          <CommitRow
            key={e.hash}
            entry={e}
            selected={selectedHashes.has(e.hash) || selectedHash === e.hash}
            tabbable={e.hash === focusableHash}
            onSelect={handleSelect}
            onContextMenu={handleRowContextMenu}
            onRowKeyDown={handleRowKeyDown}
          />
        ))}
        {/* v2：commit > 300 时在过滤栏提示缩小范围；完整列号分配 + viewport 虚拟化（spec §4.4.3 / §5.5） */}
        {!hasMore && (
          <div className="pm-commit-more">
            {entries.length >= 2000 ? '仅显示最近 2000 条，请用过滤缩小范围' : '没有更早的提交'}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: '发送到会话',
              onClick: () => sendToConversation?.request({
                kind: 'commits',
                hashes: useGitLogStore.getState().selectedHashes.size
                  ? displayOrder.filter(h => useGitLogStore.getState().selectedHashes.has(h))
                  : [menu.hash],
              }),
            },
          ]}
        />
      )}
    </>
  )
}
