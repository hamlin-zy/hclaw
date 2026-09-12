import {Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {diffChars, diffLines} from 'diff'
import type {DiffResult} from '../../../shared/types/project-manager'
import {highlightLines} from '../lib/syntaxHighlight'
import type {LineToken} from '../lib/syntaxHighlight'
import {inlineCellClass, sbsCellClass} from '../lib/diffCellClass'
import {rangeLines, toggleLine, writeClipboard} from '../lib/lineSelection'

export type DiffViewMode = 'side-by-side' | 'inline' | 'unified'

/** 选区所属的一侧；sbs 有左右两侧，inline/unified 只有单侧 */
type DiffSide = 'left' | 'right' | 'inline'
/**
 * 按行选中状态。**必须以行索引（而非 DOM 节点）为事实源** —— side-by-side 按行虚拟化，
 * 选区行可能不在当前渲染窗口内；索引集合在任何滚动位置都能还原正确高亮。
 */
type DiffSelection = {side: DiffSide, rows: number[]}

/** 选区外发快照：已翻译成「新版本文件行号」的形态，供上层构造发送上下文 */
export interface DiffSelectionSnapshot {
  side: DiffSide
  /** 新版本文件行号（升序不保证；上层按需排序） */
  lineNumbers: number[]
  /** 是否可发送（旧版本行 / 删除行不可发送） */
  sendable: boolean
  /** sendable=false 时的原因（直接用作菜单置灰提示） */
  reason?: string
}

/** 词级高亮的片段：changed 为 true 时包 `<mark>`（左右各自只保留本侧片段） */
type Seg = {value: string, changed: boolean}

type DiffRow = {
  kind: 'context' | 'change' | 'del' | 'add'
  oldNo?: number
  newNo?: number
  left?: string
  right?: string
  leftSegs?: Seg[]
  rightSegs?: Seg[]
}

/** 去掉 diff 包 hunk 尾部换行后按行拆分（与旧实现同口径） */
const splitLines = (value: string) => value.replace(/\n$/, '').split('\n')

/**
 * 字符级 diff 的**单对**规模上限（左右合计字符数）。diffChars 基于 Myers 算法，代价随差异规模
 * 近似平方增长。实测（本机 Node 24 / diff 包）：999 vs 999 完全不同 → 112ms，
 * 1999 vs 1999 → 409ms。即 2000 字符量级的单次调用已要 0.4 秒；而它是**逐配对行**调用的，
 * 一个含几十个长行（压缩 JSON/CSS、超长 import）的文件会让 render 冻结数秒。
 * 因此取 600（≈30ms 量级）作为单对护栏，而不是等到 4000。
 */
const MAX_WORD_DIFF_CHARS_PER_PAIR = 600

/**
 * 字符级 diff 的**全局预算**：buildRows 内累计所有真正做过词级 diff 的字符数。
 * 判定逐对进行（cost <= 剩余预算），故预算是**有界**而非「超限后一律降级」——
 * 预算见底后只有仍然放得下的极短配对会继续词级 diff，其余降级为整行高亮。
 * 目的是防止「每对都在阈值内、但行数极多」的文件把 render 拖垮。
 */
const MAX_WORD_DIFF_TOTAL_CHARS = 20000

/** 行高（px）：虚拟化切片与差异点导航共用同一数值，必须与 .pm-diff-row 的 CSS 行高一致 */
const ROW_HEIGHT = 20

/** 降级路径：整行都算变化片段 —— **降级 ≠ 不亮**，仍返回整行高亮而非空 mark 列表 */
function wholeLineSegs(value: string): Seg[] {
  return [{value, changed: true}]
}

/**
 * 字符级差异：一删一增配对成对的行，只高亮真正变化的片段（spec §12.3）。
 * diffChars 的公共片段既不算 added 也不算 removed → 同时保留在左右两侧，不产生 mark。
 */
function wordSegs(
  left: string,
  right: string,
  allowWordDiff: boolean,
): {leftSegs: Seg[], rightSegs: Seg[]} {
  if (!allowWordDiff) {
    return {leftSegs: wholeLineSegs(left), rightSegs: wholeLineSegs(right)}
  }
  // 左右完全一致时短路：整段都不算变化（避免把相同内容标成 change）
  if (left === right) {
    return {leftSegs: [{value: left, changed: false}], rightSegs: [{value: right, changed: false}]}
  }
  const parts = diffChars(left, right)
  return {
    leftSegs: parts.filter(p => !p.added).map(p => ({value: p.value, changed: !!p.removed})),
    rightSegs: parts.filter(p => !p.removed).map(p => ({value: p.value, changed: !!p.added})),
  }
}

/**
 * 把 diffLines 的 hunk 序列配对成「每行一个 grid row」的行模型（spec §12.2）。
 *
 * 关键点：连续的变更 hunk（removed/added 的任意组合，不依赖 diff 包内部的排列顺序）先
 * 各自聚合成删/增行池，再按序配对。第 i 行左=removed[i]、右=added[i]，`n = max(len_rem, len_add)`；
 * 某一侧不足时该侧渲染空槽。**两侧行数恒等于 n** —— 这就是左右严格对齐的机制保证。
 */
function buildRows(oldContent: string, newContent: string): DiffRow[] {
  const hunks = diffLines(oldContent, newContent)
  const rows: DiffRow[] = []
  let oldNo = 1
  let newNo = 1
  let wordDiffBudget = MAX_WORD_DIFF_TOTAL_CHARS
  let i = 0
  while (i < hunks.length) {
    const h = hunks[i]
    if (!h.added && !h.removed) {
      for (const line of splitLines(h.value)) {
        rows.push({kind: 'context', oldNo: oldNo++, newNo: newNo++, left: line, right: line})
      }
      i++
      continue
    }
    // 聚合连续的变更 hunk
    const removedLines: string[] = []
    const addedLines: string[] = []
    while (i < hunks.length && (hunks[i].added || hunks[i].removed)) {
      if (hunks[i].removed) removedLines.push(...splitLines(hunks[i].value))
      else addedLines.push(...splitLines(hunks[i].value))
      i++
    }
    const n = Math.max(removedLines.length, addedLines.length)
    for (let k = 0; k < n; k++) {
      const left = k < removedLines.length ? removedLines[k] : undefined
      const right = k < addedLines.length ? addedLines[k] : undefined
      if (left !== undefined && right !== undefined) {
        // 单对阈值 + 全局预算双重护栏：任一超出即降级为整行高亮（仍亮，只是不精确）
        const cost = left.length + right.length
        const allowWordDiff = cost <= MAX_WORD_DIFF_CHARS_PER_PAIR && cost <= wordDiffBudget
        const {leftSegs, rightSegs} = wordSegs(left, right, allowWordDiff)
        if (allowWordDiff) wordDiffBudget -= cost
        rows.push({kind: 'change', oldNo: oldNo++, newNo: newNo++, left, right, leftSegs, rightSegs})
      } else if (left !== undefined) {
        rows.push({kind: 'del', oldNo: oldNo++, left})
      } else {
        rows.push({kind: 'add', newNo: newNo++, right})
      }
    }
  }
  return rows
}

function renderSegs(segs: Seg[] | undefined, side: 'added' | 'removed', text: string) {
  if (!segs) return text
  return segs.map((s, i) =>
    s.changed
      ? <mark key={i} className={`pm-diff-word is-${side}`}>{s.value}</mark>
      : <Fragment key={i}>{s.value}</Fragment>)
}

/** 词级差异切分 × 语法着色切分「求交」后的最小渲染单元 */
export type Atom = {text: string, changed: boolean, cls: string}

/**
 * 把两个切分求交成一组扁平原子：
 * - 词级差异 `Seg[]`（`changed` 决定要不要包 `<mark>`；纯增/删行传 undefined ⇒ 整行都不包）
 * - 语法着色 `LineToken[]`（`cls` 决定要不要包着色 `<span>`）
 * 两个切分各自都是**无损覆盖整行**的，求交后仍无损 —— 这是硬不变量，任一侧对不上就返回 null，
 * 调用方退回原渲染路径（宁可不着色，不可错位、不可丢字）。
 */
export function toAtoms(
  segs: Seg[] | undefined,
  tokens: LineToken[],
  lineText: string,
): Atom[] | null {
  const segsList = segs ?? [{value: lineText, changed: false}]
  if (lineText === '') return []
  if (segsList.map(s => s.value).join('') !== lineText) return null
  if (tokens.map(tk => tk.text).join('') !== lineText) return null
  const atoms: Atom[] = []
  let si = 0, soff = 0, ti = 0, toff = 0
  while (si < segsList.length && ti < tokens.length) {
    const s = segsList[si], tk = tokens[ti]
    const n = Math.min(s.value.length - soff, tk.text.length - toff)
    if (n <= 0) return null
    const text = s.value.slice(soff, soff + n)
    // 相邻同 (changed, cls) 的原子就地合并，避免把一行拆成大量碎片 span
    const last = atoms[atoms.length - 1]
    if (last && last.changed === s.changed && last.cls === tk.cls) last.text += text
    else atoms.push({text, changed: s.changed, cls: tk.cls})
    soff += n
    if (soff === s.value.length) { si++; soff = 0 }
    toff += n
    if (toff === tk.text.length) { ti++; toff = 0 }
  }
  if (si !== segsList.length || ti !== tokens.length) return null
  return atoms
}

/** 行号 → 该行着色片段。**防御性校验**：拼回来必须逐字等于该侧行文本，否则返回 null 走无着色渲染 */
function pickLineTokens(
  tokens: LineToken[][] | null,
  lineNo: number | undefined,
  lineText: string,
): LineToken[] | null {
  if (!tokens || lineNo === undefined) return null
  const line = tokens[lineNo - 1]
  if (!line) return null
  return line.map(tk => tk.text).join('') === lineText ? line : null
}

function atomNode(a: Atom, key: number) {
  return a.cls
    ? <span key={key} className={a.cls}>{a.text}</span>
    : <Fragment key={key}>{a.text}</Fragment>
}

function renderAtoms(atoms: Atom[], side: 'added' | 'removed') {
  const out: ReactNode[] = []
  for (let i = 0; i < atoms.length;) {
    if (atoms[i].changed) {
      // 连续的 changed 原子必须收进**同一个** <mark>：词级高亮是一个语义区间，
      // 按着色片段拆成多个 mark 会让「真正变化的片段」被切碎（既有测试断言 mark 的 textContent）
      const group: Atom[] = []
      while (i < atoms.length && atoms[i].changed) group.push(atoms[i++])
      out.push(
        <mark key={out.length} className={`pm-diff-word is-${side}`}>
          {group.map((g, j) => atomNode(g, j))}
        </mark>,
      )
    } else {
      out.push(atomNode(atoms[i++], out.length))
    }
  }
  return out
}

export function DiffViewer({data, viewMode, navSignal, onSelectionChange}: {data: DiffResult, viewMode: DiffViewMode, navSignal?: {dir: 'prev' | 'next', n: number} | null, onSelectionChange?: (sel: DiffSelectionSnapshot | null) => void}) {
  const rows = useMemo(() => buildRows(data.oldContent, data.newContent), [data])
  /**
   * 逐行语法着色数据（左右各一份）。null = 尚未加载 / 该文件不是代码 / 着色失败 / 超预算，
   * 此时渲染路径与从前**完全一致**（零额外 DOM、零回归）。
   */
  const [tokens, setTokens] = useState<{old: LineToken[][] | null, new: LineToken[][] | null} | null>(null)
  useEffect(() => {
    let cancelled = false
    setTokens(null)
    Promise.all([
      highlightLines(data.oldContent, data.filePath),
      highlightLines(data.newContent, data.filePath),
    ]).then(([oldTokens, newTokens]) => {
      // 两侧都不可着色（非代码文件）→ 保持 null，不触发任何渲染变化
      if (cancelled || (!oldTokens && !newTokens)) return
      setTokens({old: oldTokens, new: newTokens})
    }).catch(() => {
      // 着色是可选的增强：失败就退回单色渲染，不影响 diff 本身
    })
    return () => { cancelled = true }
  }, [data])
  /**
   * 单侧单元格渲染：有着色数据走「求交」后的原子渲染，否则逐字回落到原 renderSegs。
   * 注意 `.pm-diff-code.is-added/.is-removed` 的行背景与 `.pm-diff-word` 的词级 mark
   * 都是外层/包裹元素，语法着色的 `<span>` 只改前景色，二者互不覆盖。
   */
  const renderLine = (
    text: string | undefined,
    segs: Seg[] | undefined,
    side: 'added' | 'removed',
    lineNo: number | undefined,
    sideTokens: LineToken[][] | null,
  ): ReactNode => {
    if (text === undefined) return ''
    const lineTokens = pickLineTokens(sideTokens, lineNo, text)
    if (!lineTokens) return renderSegs(segs, side, text)
    const atoms = toAtoms(segs, lineTokens, text)
    return atoms ? renderAtoms(atoms, side) : renderSegs(segs, side, text)
  }
  // 挂载后（或 viewMode 变化时）把首个变更行 scroll 居中，仅触发一次
  const scrollDone = useRef(false)
  useEffect(() => {
    if (scrollDone.current) return
    scrollDone.current = true
    // 兼容 jsdom：Element.prototype.scrollIntoView 在 jsdom 中未定义，需可选链
    const el = document.querySelector<HTMLElement>('[data-first-change]')
    el?.scrollIntoView?.({block: 'center', behavior: 'instant'})
  }, [viewMode, data])

  // 差异点导航：navSignal 变化时滚动到上一个/下一个差异块
  useEffect(() => {
    if (!navSignal) return
    // 找到所有变更行的索引（非 context）
    const changeIdx: number[] = []
    rows.forEach((r, i) => { if (r.kind !== 'context') changeIdx.push(i) })
    if (changeIdx.length === 0) return
    const scroller = sbsScrollRef.current
    if (!scroller) return
    // 将连续变更行分组成"差异块"，每块记录起始和结束行索引
    const blocks: {start: number, end: number}[] = []
    for (let i = 0; i < changeIdx.length; i++) {
      if (i === 0 || changeIdx[i] !== changeIdx[i - 1] + 1) {
        blocks.push({start: changeIdx[i], end: changeIdx[i]})
      } else {
        blocks[blocks.length - 1].end = changeIdx[i]
      }
    }
    // 当前视口中心对应的行索引
    const centerRow = Math.round((scroller.scrollTop + scroller.clientHeight / 2) / ROW_HEIGHT)
    // 找当前中心位于哪个块范围内（或刚过完哪个块）
    // 末块特判：跳到末块时 scrollTop 被钳制到底部，centerRow 可能超出末块 end，
    // 但视口实际正在看末块 → 视为 inBlock，否则 prev 会跳回末块自身（不动）
    let curBlock = -1
    let inBlock = false
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].start <= centerRow) {
        curBlock = i
        inBlock = i === blocks.length - 1 || centerRow <= blocks[i].end
      } else break
    }
    // 确定目标块：
    // prev — 在块内跳到上一块；在 gap 中跳回刚过完的块
    // next — 跳到下一个块
    const targetBlock = navSignal.dir === 'prev'
      ? Math.max(0, inBlock ? curBlock - 1 : curBlock)
      : Math.min(blocks.length - 1, curBlock + 1)
    // 滚动到目标块起始行，居中
    const targetRow = blocks[targetBlock].start
    const targetTop = targetRow * ROW_HEIGHT - scroller.clientHeight / 2 + ROW_HEIGHT / 2
    scroller.scrollTop = Math.max(0, targetTop)
  }, [navSignal])

  /**
   * side-by-side「中线恒居中 + 两侧共用横向滚动条」的两个 CSS 变量（测量侧）。
   *
   * 静止不再靠「反向平移补偿」凑出来：行号槽与中线改由原生 position: sticky 钉住
   * （合成线程逐帧精确，不存在补偿量与原生动位移差一帧的问题，见 globals.css 的 .pm-diff--sbs 区块）。
   * 只保留代码内容自身的平移（.pm-diff-line + 滚动时间线 --pm-diff-h）：内容在动，
   * 即使差一帧也远不可见。
   *
   * 这里只测量「事实量」，都写在滚动容器上（所有行 / 单元格都是它的后代，靠继承下发，
   * 内联优先于 globals.css 里的兜底声明）：
   *   --pm-diff-content-w 最长行的自然宽度（px）→ 与 --pm-diff-half 一起决定行宽（= 滚动范围）
   *   --pm-diff-view-w    可视区宽（px）→ 右代码列宽
   *   --pm-diff-half      可视区半宽（px）→ 中线 sticky 的 left、两侧代码列宽
   *   --pm-diff-max-sx    横向滚动范围（px，= scrollWidth − clientWidth）→ 内容平移的终点
   * jsdom 无布局（offsetWidth / scrollWidth 恒 0）→ 变量都不写、不抛错、不产生内联 style。
   */
  const sbsScrollRef = useRef<HTMLDivElement | null>(null)
  const contentWSetRef = useRef(false)
  const geomSetRef = useRef(false)
  const maxSxSetRef = useRef(false)

  // --- 虚拟化（side-by-side）：只渲染可见行 + overscan，避免大文件 DOM 爆炸 ---
  const OVERSCAN = 5
  const [vScroll, setVScroll] = useState(0)
  const [vHeight, setVHeight] = useState(0)
  const rafRef = useRef(0)

  const onSbsScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const el = sbsScrollRef.current
      if (!el) return
      setVScroll(el.scrollTop)
      setVHeight(el.clientHeight)
    })
  }, [])

  useLayoutEffect(() => {
    const el = sbsScrollRef.current
    if (!el) return
    setVScroll(el.scrollTop)
    setVHeight(el.clientHeight)
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 } }
  }, [])

  // 切 diff 文件（data 变化）时重置虚拟化状态：
  // vScroll 从上一个文件残留 → 可见范围超出新文件的行数 → 内容空白
  // scrollDone.current 未重置 → scrollIntoView 不再执行 → 无法定位首个变更行
  useLayoutEffect(() => {
    scrollDone.current = false
    setVScroll(0)
    const el = sbsScrollRef.current
    if (el) el.scrollTop = 0
  }, [data])

  // 可视区几何 + 最长行宽度 + 横向滚动范围：.pm-diff-line 是 width: max-content 的块，
  // offsetWidth 即文本自然宽度（transform 只改绘制不改布局宽度，中途滚动过再测也是准的）
  // 必须 useLayoutEffect：列宽与中线位置**依赖这几个测量值**（未测量时 CSS 兜底值是 0px，
  // 列宽会退化成负值、中线跑到左缘）。放在 useEffect 里会先 paint 一帧坏布局再修正。
  useLayoutEffect(() => {
    if (viewMode !== 'side-by-side') return
    const scroller = sbsScrollRef.current
    if (!scroller) return

    const clearAll = () => {
      if (contentWSetRef.current) {
        contentWSetRef.current = false
        scroller.style.removeProperty('--pm-diff-content-w')
      }
      if (geomSetRef.current) {
        geomSetRef.current = false
        scroller.style.removeProperty('--pm-diff-view-w')
        scroller.style.removeProperty('--pm-diff-half')
      }
      if (maxSxSetRef.current) {
        maxSxSetRef.current = false
        scroller.style.removeProperty('--pm-diff-max-sx')
      }
    }

    const measure = () => {
      let widest = 0
      for (const line of scroller.querySelectorAll<HTMLElement>('.pm-diff-line')) {
        if (line.offsetWidth > widest) widest = line.offsetWidth
      }
      // 无布局（jsdom）或没有任何内容：不写变量。若之前写过（切到大文件再切回空 diff），
      // 必须清干净 —— 否则会留下「没东西可滚」的幽灵横向滚动条 / 残留的动画终点
      if (widest <= 0) {
        clearAll()
        return
      }
      contentWSetRef.current = true
      geomSetRef.current = true
      // 三个变量都是布局输入（行宽 = content-w + half + 49px，列宽用 view-w / half），
      // 必须先全部落地再测滚动范围
      scroller.style.setProperty('--pm-diff-content-w', `${widest}px`)
      scroller.style.setProperty('--pm-diff-view-w', `${Math.round(scroller.clientWidth)}px`)
      scroller.style.setProperty('--pm-diff-half', `${Math.round(scroller.clientWidth / 2)}px`)
      // 行宽/列宽依赖刚写入的变量：读取前强制 reflow，确保新宽度已参与布局
      void scroller.offsetWidth
      const maxSx = scroller.scrollWidth - scroller.clientWidth
      if (maxSx > 0) {
        maxSxSetRef.current = true
        scroller.style.setProperty('--pm-diff-max-sx', `${maxSx}px`)
      } else if (maxSxSetRef.current) {
        maxSxSetRef.current = false
        scroller.style.removeProperty('--pm-diff-max-sx')
      }
    }

    measure()

    // 滚动范围依赖可视区宽度（窗口 resize、纵向滚动条出现/消失都会变）→ 容器尺寸变化时重测
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure())
      ro.observe(scroller)
    }

    return () => {
      ro?.disconnect()
      contentWSetRef.current = false
      geomSetRef.current = false
      maxSxSetRef.current = false
      scroller.style.removeProperty('--pm-diff-content-w')
      scroller.style.removeProperty('--pm-diff-view-w')
      scroller.style.removeProperty('--pm-diff-half')
      scroller.style.removeProperty('--pm-diff-max-sx')
    }
    // tokens 也要重测：注释等着色片段带 font-style: italic，可能微调字宽
  }, [viewMode, data, tokens, vHeight])

  // ---- 按行选中（IDEA 风格）：选区以「行索引集合 + 所属侧」存储 ----
  const [selection, setSelection] = useState<DiffSelection | null>(null)
  const selAnchor = useRef<number | null>(null)
  const dragSide = useRef<DiffSide | null>(null)
  const dragMove = useRef<((e: MouseEvent) => void) | null>(null)
  const dragUp = useRef<(() => void) | null>(null)

  const applySelection = useCallback((next: DiffSelection | null) => {
    setSelection(next && next.rows.length ? next : null)
  }, [])

  /** 从事件目标解析行索引：要求落在同一侧（cells 带 data-row / data-side） */
  const resolveRow = useCallback((target: EventTarget | null, side: DiffSide): number | null => {
    if (!(target instanceof Element)) return null
    const el = target.closest('[data-row][data-side]')
    if (!el || el.getAttribute('data-side') !== side) return null
    const n = Number(el.getAttribute('data-row'))
    return Number.isInteger(n) ? n : null
  }, [])

  const endDrag = useCallback(() => {
    if (dragMove.current) document.removeEventListener('mousemove', dragMove.current)
    if (dragUp.current) document.removeEventListener('mouseup', dragUp.current)
    dragMove.current = null
    dragUp.current = null
    dragSide.current = null
  }, [])

  // 卸载时注销拖动监听（监听器泄漏有严格审查）
  useEffect(() => endDrag, [endDrag])

  // 切换 diff 文件 / 视图模式时清空选区并结束拖动：
  // 选区索引语义随行模型变化而失效；拖动中若只清选区不 endDrag()，
  // 残留的 document mousemove 会继续用旧 dragSide 往新文件的行索引上写。
  useEffect(() => {
    setSelection(null)
    selAnchor.current = null
    endDrag()
  }, [data, viewMode, endDrag])

  const beginDrag = useCallback((side: DiffSide) => {
    endDrag()
    dragSide.current = side
    const move = (e: MouseEvent) => {
      // 拖动期间左键已被松开（例如先松键再移动）→ 不再扩选，避免「悬停即扩选」
      if ((e.buttons & 1) === 0) return
      const s = dragSide.current
      if (s === null || selAnchor.current === null) return
      const row = resolveRow(e.target, s)
      if (row === null) return
      applySelection({side: s, rows: rangeLines(selAnchor.current, row)})
    }
    const up = () => endDrag()
    dragMove.current = move
    dragUp.current = up
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }, [applySelection, endDrag, resolveRow])

  /**
   * 单元格按下：按修饰键决定选区语义。点击另一侧会清空原侧（同一时刻只有一侧有选区）。
   * 返回前 preventDefault 抑制原生文本选择。
   */
  const startSelect = useCallback((side: DiffSide, row: number, event: React.MouseEvent) => {
    // 只接管左键：右键要弹上下文菜单，不应同时起选并启动拖动（与 CodeEditor 的 event.button !== 0 对齐）
    if (event.button !== 0) return
    event.preventDefault()
    const current = selection && selection.side === side ? selection : null
    if (event.ctrlKey || event.metaKey) {
      applySelection({side, rows: toggleLine(current ? current.rows : [], row)})
      selAnchor.current = row
      return
    }
    if (event.shiftKey && current && selAnchor.current !== null) {
      applySelection({side, rows: rangeLines(selAnchor.current, row)})
      return
    }
    applySelection({side, rows: [row]})
    selAnchor.current = row
    beginDrag(side)
  }, [applySelection, beginDrag, selection])

  /** 双击仍按整行处理（diff 里本无词级选区，这里显式吞掉默认行为保持一致语义） */
  const rowDoubleClick = useCallback((side: DiffSide, row: number, event: React.MouseEvent) => {
    event.preventDefault()
    applySelection({side, rows: [row]})
    selAnchor.current = row
  }, [applySelection])

  // inline / unified 同为单列：删行 / 增行拆成两行，前缀 +/-，首个变更行打 data-first-change
  // useMemo([rows])：否则每帧换引用，选区激活期间每次渲染都要 remove/add 一次 keydown 监听
  const inlineRows = useMemo(() => {
    const out: {kind: 'context' | 'del' | 'add', no?: number, prefix: string, text: string, segs?: Seg[]}[] = []
    for (const r of rows) {
      if (r.kind === 'context') {
        out.push({kind: 'context', no: r.newNo, prefix: ' ', text: r.left ?? ''})
      } else if (r.kind === 'change') {
        out.push({kind: 'del', no: r.oldNo, prefix: '-', text: r.left ?? '', segs: r.leftSegs})
        out.push({kind: 'add', no: r.newNo, prefix: '+', text: r.right ?? '', segs: r.rightSegs})
      } else if (r.kind === 'del') {
        out.push({kind: 'del', no: r.oldNo, prefix: '-', text: r.left ?? ''})
      } else {
        out.push({kind: 'add', no: r.newNo, prefix: '+', text: r.right ?? ''})
      }
    }
    return out
  }, [rows])

  // ---- 选区快照外发：把「哪一侧的哪些行索引」翻译成新版本文件行号 ----
  // 回调经 ref 读取而**不进依赖**：调用方（EditorArea）传的是内联箭头，每次渲染都是新引用，
  // 若进 deps 会让下面的 effect 每渲染都重跑并再次外发，形成抖动。
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange

  const emitSnapshot = useCallback((sel: DiffSelection | null): DiffSelectionSnapshot | null => {
    if (!sel || sel.rows.length === 0) return null
    if (sel.side === 'left') {
      // 旧版本行在新版本里没有对应行号 → 不可发送
      const lineNumbers = sel.rows.map(i => rows[i]?.oldNo).filter((n): n is number => typeof n === 'number')
      return {side: 'left', lineNumbers, sendable: false, reason: '仅新版本行可发送'}
    }
    if (sel.side === 'right') {
      const lineNumbers = sel.rows.map(i => rows[i]?.newNo).filter((n): n is number => typeof n === 'number')
      return {side: 'right', lineNumbers, sendable: lineNumbers.length > 0}
    }
    // inline / unified：单列模型，删行只有 oldNo、没有新版本行号 → 剔除；全被剔除则不可发送
    const lineNumbers = sel.rows
      .map(i => inlineRows[i])
      .filter((r): r is NonNullable<typeof r> => r !== undefined && r.kind !== 'del')
      .map(r => r.no)
      .filter((n): n is number => typeof n === 'number')
    return lineNumbers.length > 0
      ? {side: 'inline', lineNumbers, sendable: true}
      : {side: 'inline', lineNumbers, sendable: false, reason: '删除行不可发送'}
  }, [rows, inlineRows])

  // 外发时机 = 选区变化。data / viewMode 切换时上面的清空 effect（:489-496）会 setSelection(null)，
  // 于是这里自然外发 null，上层据此收起菜单。挂载时也会发一次 null（幂等）。
  // 但清空 effect 的 setSelection(null) 只是**排程**：同一 commit 内本 effect 仍会以本次渲染的旧
  // selection 配合新的 rows 翻译 → 抢先把「用新行模型 + 旧行索引」拼出的错值快照（sendable:true）
  // 外发出去，下一次渲染才补发 null。用 ref 判定本 commit 是否刚换了 data / viewMode，是则直接发 null。
  const emitKeyRef = useRef({data, viewMode})
  useEffect(() => {
    const k = emitKeyRef.current
    const stale = k.data !== data || k.viewMode !== viewMode
    emitKeyRef.current = {data, viewMode}
    onSelectionChangeRef.current?.(stale ? null : emitSnapshot(selection))
  }, [selection, emitSnapshot, data, viewMode])

  /** 所选行的原文（side-by-side 取该侧纯文本；inline 保留 +/-/空格 前缀） */
  const copySelection = useCallback(() => {
    if (!selection) return
    const sorted = [...selection.rows].sort((a, b) => a - b)
    const text = selection.side === 'inline'
      ? sorted.map(i => { const r = inlineRows[i]; return r ? r.prefix + r.text : '' }).join('\n')
      : sorted.map(i => {
        const r = rows[i]
        if (!r) return ''
        return (selection.side === 'left' ? r.left : r.right) ?? ''
      }).join('\n')
    // 剪贴板写入与 CodeEditor 复用同一实现（失败会 console.warn，不静默吞掉）
    writeClipboard(text)
  }, [selection, inlineRows, rows])

  // 选区激活期间监听 Ctrl/Cmd+A、Esc、Ctrl/Cmd+C。
  // 落点与 CodeEditor **刻意不同**：diff 视图本身不抢焦点、无 contenteditable，键盘只能走
  // document 级监听；CodeEditor 则走 `EditorView.domEventHandlers`（挂在 contentDOM 上，
  // 需补 tabindex 才可聚焦）。两者语义一致，事件落点不可互换（详见 lib/lineSelection.ts 头注）。
  useEffect(() => {
    if (!selection) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'a' || e.key === 'A')) {
        // 行索引是 0-based：全选 = 0 .. 总数-1
        const total = selection.side === 'inline' ? inlineRows.length : rows.length
        applySelection({side: selection.side, rows: Array.from({length: total}, (_, i) => i)})
        e.preventDefault()
      } else if (e.key === 'Escape') {
        applySelection(null)
        // 一并清锚点：与 CodeEditor 语义对齐，Esc 后 Shift+单击从新位置重锚
        selAnchor.current = null
        e.preventDefault()
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        copySelection()
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selection, inlineRows, rows, applySelection, copySelection])

  /** 当前选中的行索引集合（供渲染判断；与虚拟化窗口无关） */
  const selectedRows = useMemo(
    () => new Set(selection ? selection.rows : []),
    [selection],
  )
  const selectionSide = selection?.side ?? null

  if (viewMode === 'side-by-side') {
    const firstChangeRowIdx = rows.findIndex(r => r.kind !== 'context')
    // 虚拟化：只渲染可见行 + overscan。vHeight=0 时（jsdom 或尚未测量）不虚拟化，渲染全部行
    const startIdx = Math.max(0, Math.floor(vScroll / ROW_HEIGHT) - OVERSCAN)
    const endIdx = vHeight === 0
      ? rows.length
      : Math.min(rows.length, Math.ceil((vScroll + vHeight) / ROW_HEIGHT) + OVERSCAN)
    // 首次渲染时确保 first-change 行在 DOM 中（供 scrollIntoView 定位）
    const needFirstChange = !scrollDone.current && firstChangeRowIdx >= 0
    const vStart = needFirstChange && firstChangeRowIdx < startIdx
      ? Math.max(0, firstChangeRowIdx - OVERSCAN) : startIdx
    const vEnd = needFirstChange && firstChangeRowIdx >= endIdx
      ? Math.min(rows.length, firstChangeRowIdx + OVERSCAN + 1) : endIdx
    const topSpacer = vStart * ROW_HEIGHT
    const bottomSpacer = (rows.length - vEnd) * ROW_HEIGHT
    return (
      <div className="pm-diff-scroll" ref={sbsScrollRef} onScroll={onSbsScroll}>
        <div data-testid="diff-side-by-side" className="pm-diff pm-diff--sbs">
          {topSpacer > 0 && <div style={{height: topSpacer}} aria-hidden />}
          {rows.slice(vStart, vEnd).map((r, i) => {
            const idx = vStart + i
            // 左（删除）侧：无内容 → 空槽；本行含删除 → 删除色；context → 中性
            // 右（新增）侧镜像但**不对称**（详见 lib/diffCellClass.ts 的规则说明）
            const leftKind = sbsCellClass(r, 'left')
            const rightKind = sbsCellClass(r, 'right')
            const leftSel = selectionSide === 'left' && selectedRows.has(idx)
            const rightSel = selectionSide === 'right' && selectedRows.has(idx)
            return (
              <div key={idx} className="pm-diff-row">
                {/* data-first-change 落在行号槽而不是行容器上：整份 diff 只允许一个锚点，
                    且锚点元素自身必须有盒子（不能依赖行容器的布局类型） */}
                <div
                  className={`pm-diff-gutter${leftKind}${leftSel ? ' is-selected' : ''}`}
                  data-first-change={idx === firstChangeRowIdx || undefined}
                  data-row={idx}
                  data-side="left"
                  onMouseDown={e => startSelect('left', idx, e)}
                  onDoubleClick={e => rowDoubleClick('left', idx, e)}
                >{r.oldNo ?? ''}</div>
                <div
                  className={`pm-diff-code${leftKind}${leftSel ? ' is-selected' : ''}`}
                  data-testid={r.kind === 'del' || r.kind === 'change' ? 'diff-line-deleted' : undefined}
                  data-row={idx}
                  data-side="left"
                  onMouseDown={e => startSelect('left', idx, e)}
                  onDoubleClick={e => rowDoubleClick('left', idx, e)}
                ><span className="pm-diff-line">{renderLine(r.left, r.leftSegs, 'removed', r.oldNo, tokens?.old ?? null)}</span></div>
                <div
                  className={`pm-diff-gutter${rightKind}${rightSel ? ' is-selected' : ''}`}
                  data-row={idx}
                  data-side="right"
                  onMouseDown={e => startSelect('right', idx, e)}
                  onDoubleClick={e => rowDoubleClick('right', idx, e)}
                >{r.newNo ?? ''}</div>
                <div
                  className={`pm-diff-code${rightKind}${rightSel ? ' is-selected' : ''}`}
                  data-testid={r.kind === 'add' || r.kind === 'change' ? 'diff-line-added' : undefined}
                  data-row={idx}
                  data-side="right"
                  onMouseDown={e => startSelect('right', idx, e)}
                  onDoubleClick={e => rowDoubleClick('right', idx, e)}
                ><span className="pm-diff-line">{renderLine(r.right, r.rightSegs, 'added', r.newNo, tokens?.new ?? null)}</span></div>
              </div>
            )
          })}
          {bottomSpacer > 0 && <div style={{height: bottomSpacer}} aria-hidden />}
        </div>
      </div>
    )
  }

  const firstChangeIdx = inlineRows.findIndex(r => r.kind !== 'context')
  return (
    <div className="pm-diff-scroll" ref={sbsScrollRef}>
      <div data-testid="diff-inline" className="pm-diff pm-diff--inline">
        {inlineRows.map((r, i) => {
          const kind = inlineCellClass(r.kind)
          const sel = selectionSide === 'inline' && selectedRows.has(i)
          return (
            <div
              key={i}
              className={`pm-diff-inline-row${kind}${sel ? ' is-selected' : ''}`}
              data-testid={r.kind === 'add' ? 'diff-line-added' : r.kind === 'del' ? 'diff-line-deleted' : undefined}
              data-first-change={i === firstChangeIdx || undefined}
              data-row={i}
              data-side="inline"
              onMouseDown={e => startSelect('inline', i, e)}
              onDoubleClick={e => rowDoubleClick('inline', i, e)}
            >
              <span className={`pm-diff-gutter${kind}`}>{r.no ?? ''}</span>
              <span className={`pm-diff-code${kind}`}>{r.prefix}{renderLine(
                r.text, r.segs, r.kind === 'add' ? 'added' : 'removed', r.no,
                r.kind === 'del' ? (tokens?.old ?? null) : (tokens?.new ?? null),
              )}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
