// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {DiffViewer} from '../../../src/renderer/project-manager/components/DiffViewer'

describe('DiffViewer', () => {
  const data = {
    filePath: 'a.ts', oldContent: 'line1\nline2', newContent: 'line1\nline2 changed',
    diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'worktree', additions: 1, deletions: 1,
  }
  beforeEach(() => {
    // jsdom 未实现 scrollIntoView，stub 之
    Element.prototype.scrollIntoView = vi.fn()
  })
  it('渲染新增/删除行标记', () => {
    render(<DiffViewer data={data} viewMode="inline" />)
    // diff 包对单行修改输出 del+add；断言删行与加行都出现
    expect(screen.getAllByTestId('diff-line-deleted').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByTestId('diff-line-added').length).toBeGreaterThanOrEqual(1)
  })
  it('side-by-side 模式渲染两列容器', () => {
    render(<DiffViewer data={data} viewMode="side-by-side" />)
    expect(screen.getByTestId('diff-side-by-side')).toBeInTheDocument()
  })
  it('inline 模式：首个变更行打 data-first-change 并调用 scrollIntoView 居中', () => {
    const {container} = render(<DiffViewer data={data} viewMode="inline" />)
    const first = container.querySelector('[data-first-change]')
    expect(first).not.toBeNull()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({block: 'center', behavior: 'instant'})
  })
  it('side-by-side 模式：首个变更 hunk 打 data-first-change 并调用 scrollIntoView', () => {
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" />)
    const first = container.querySelector('[data-first-change]')
    expect(first).not.toBeNull()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
  })
  it('全 context diff（无变更）不标记首个变更行也不滚动', () => {
    const contextOnly = {...data, newContent: 'line1\nline2'}
    const {container} = render(<DiffViewer data={contextOnly} viewMode="inline" />)
    expect(container.querySelector('[data-first-change]')).toBeNull()
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  // --- spec §12.2 严格行对齐 ---
  it('side-by-side 增删行数不等时左右 gutter 严格配对，多出的一侧渲染 is-blank 空槽', () => {
    const uneven = {...data, oldContent: 'a\nb\nc\nd', newContent: 'a\nX\nd'}
    const {container} = render(<DiffViewer data={uneven} viewMode="side-by-side" />)
    const rows = container.querySelectorAll('.pm-diff-row')
    expect(rows.length).toBeGreaterThan(0)
    // 每一 grid row 恰好 2 个 gutter（左 + 右）→ 同 y 对齐的结构前提
    for (const row of Array.from(rows)) {
      expect(row.querySelectorAll('.pm-diff-gutter').length).toBe(2)
    }
    // 左右两侧 gutter 总数相等（各 = 行数）
    expect(container.querySelectorAll('.pm-diff-gutter').length).toBe(rows.length * 2)
    // 空槽存在，且 gutter 空槽与 code 空槽一一对应
    const blankGutters = container.querySelectorAll('.pm-diff-gutter.is-blank').length
    const blankCodes = container.querySelectorAll('.pm-diff-code.is-blank').length
    expect(blankCodes).toBeGreaterThanOrEqual(1)
    expect(blankGutters).toBe(blankCodes)
  })

  // --- spec §12.4 不折行（jsdom 不解析外部 CSS，读 globals.css 静态断言） ---
  it('长行不折行：.pm-diff-code 含 white-space: pre，且不含 overflow-x（逐单元格滚动是 bug 根因）', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    const at = css.indexOf('.pm-diff-code {')
    expect(at).toBeGreaterThanOrEqual(0)
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
    expect(body).toContain('white-space: pre')
    // 回归护栏：每个代码单元格各自滚动 → 每个 grid row 下一条横向滚动条
    expect(body).not.toContain('overflow-x')
    expect(body).not.toContain('overflow-y')
  })

  // --- 横向滚动上移到单一容器（jsdom 不做布局，静态断言 + DOM 结构断言） ---
  it('.pm-diff-scroll 是整份 diff 唯一的横向滚动容器（overflow: auto）', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    const at = css.indexOf('.pm-diff-scroll {')
    expect(at).toBeGreaterThanOrEqual(0)
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
    expect(body).toContain('overflow: auto')
  })

  it('side-by-side / inline 两种模式下整份 diff 只有一个横向滚动容器', () => {
    for (const [viewMode, testId] of [['side-by-side', 'diff-side-by-side'], ['inline', 'diff-inline']] as const) {
      const {container, unmount} = render(<DiffViewer data={data} viewMode={viewMode} />)
      const scrolls = container.querySelectorAll('.pm-diff-scroll')
      expect(scrolls.length).toBe(1)
      // 滚动容器是视图根节点的父元素（左右两侧共用同一个滚动条）
      expect(scrolls[0]!.querySelector(`[data-testid="${testId}"]`)).not.toBeNull()
      expect(scrolls[0]!.firstElementChild).toBe(screen.getByTestId(testId))
      unmount()
    }
  })

  it('.pm-diff 列宽用 max-content 下限 + 宽度 max-content，横向滚动才由容器承担', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    const at = css.indexOf('.pm-diff {')
    expect(at).toBeGreaterThanOrEqual(0)
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
    expect(body).toContain('minmax(max-content, 1fr)')
    expect(body).toContain('width: max-content')
    expect(body).toContain('min-width: 100%')
  })

  // --- spec §12.3 词级高亮 ---
  it('词级高亮只标记真正变化的片段', () => {
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" />)
    const added = container.querySelectorAll('.pm-diff-word.is-added')
    expect(added.length).toBeGreaterThanOrEqual(1)
    // 'line2' → 'line2 changed'：新增片段只能是 ' changed'（不含未变的 'line2'）
    expect(added[0].textContent).toBe(' changed')
  })

  // --- 回归：inline 容器必须是扁平块，否则单列行被塞进 4 列 grid ---
  it('inline 模式：globals.css 的 .pm-diff--inline 关掉 4 列 grid（display: block）', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    const at = css.indexOf('.pm-diff--inline {')
    expect(at).toBeGreaterThanOrEqual(0)
    // 级联靠顺序取胜：.pm-diff--inline 必须写在 .pm-diff（display: grid）之后，
    // 否则同特异度下 grid 会重新压过 block —— 这正是本 bug 的根因类别。
    expect(at).toBeGreaterThan(css.indexOf('.pm-diff {'))
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
    // .pm-diff 的 grid-template-columns 是 4 列；inline 必须是单列流式块
    expect(body).toContain('display: block')
  })

  // --- 回归：data-first-change 必须落在真正生成盒子的元素上 ---
  it('side-by-side：data-first-change 不落在 display:contents 的行容器上', () => {
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" />)
    const el = container.querySelector('[data-first-change]')
    expect(el).not.toBeNull()
    // .pm-diff-row 是 display: contents → getBoundingClientRect 为零矩形，scrollIntoView 失效
    expect(el!.className).not.toContain('pm-diff-row')
    expect(el!.className).toContain('pm-diff-gutter')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({block: 'center', behavior: 'instant'})
    // 契约：整份 diff 只出现一个 data-first-change
    expect(container.querySelectorAll('[data-first-change]').length).toBe(1)
  })

  // --- 空槽方位：不能只校验数量，必须校验落在较少的一侧 ---
  it('side-by-side：删 3 增 5 → 空槽全部落在左侧（删行少的一侧）', () => {
    const uneven = {...data, oldContent: 'old1\nold2\nold3', newContent: 'new1\nnew2\nnew3\nnew4\nnew5'}
    const {container} = render(<DiffViewer data={uneven} viewMode="side-by-side" />)
    const rows = Array.from(container.querySelectorAll('.pm-diff-row'))
    const blankLeft = rows.filter(r => r.querySelectorAll('.pm-diff-gutter')[0].classList.contains('is-blank')).length
    const blankRight = rows.filter(r => r.querySelectorAll('.pm-diff-gutter')[1].classList.contains('is-blank')).length
    expect(blankLeft).toBe(2)
    expect(blankRight).toBe(0)
  })

  it('side-by-side：删 5 增 2 → 空槽全部落在右侧（增行少的一侧）', () => {
    const uneven = {...data, oldContent: 'old1\nold2\nold3\nold4\nold5', newContent: 'new1\nnew2'}
    const {container} = render(<DiffViewer data={uneven} viewMode="side-by-side" />)
    const rows = Array.from(container.querySelectorAll('.pm-diff-row'))
    const blankLeft = rows.filter(r => r.querySelectorAll('.pm-diff-gutter')[0].classList.contains('is-blank')).length
    const blankRight = rows.filter(r => r.querySelectorAll('.pm-diff-gutter')[1].classList.contains('is-blank')).length
    expect(blankRight).toBe(3)
    expect(blankLeft).toBe(0)
  })

  // --- 词级 diff 性能护栏：单对阈值 + 全局预算 ---
  it('超过单对阈值的配对行降级为整行高亮（仍有 mark，不是无高亮）', () => {
    const leftLine = 'A'.repeat(500) + 'x'
    const rightLine = 'A'.repeat(500) + 'y'
    const {container} = render(
      <DiffViewer data={{...data, oldContent: leftLine, newContent: rightLine}} viewMode="side-by-side" />)
    const added = Array.from(container.querySelectorAll('.pm-diff-code.is-added .pm-diff-word.is-added'))
    expect(added.length).toBe(1)
    // 降级 = 整行高亮（旧实现会只亮 'y'，说明阈值仍过大）
    expect(added[0].textContent).toBe(rightLine)
  })

  it('词级 diff 总预算耗尽后，后续配对行降级为整行高亮而非静默失效', () => {
    const line = (tag: string, i: number) => 'A'.repeat(276) + tag + String(i).padStart(3, '0')
    const oldContent = Array.from({length: 40}, (_, i) => line('o', i)).join('\n')
    const newContent = Array.from({length: 40}, (_, i) => line('n', i)).join('\n')
    const {container} = render(<DiffViewer data={{...data, oldContent, newContent}} viewMode="side-by-side" />)
    const marks = Array.from(container.querySelectorAll('.pm-diff-code.is-added .pm-diff-word.is-added'))
    expect(marks.length).toBe(40)               // 降级 ≠ 不亮：每行都仍有 mark
    expect(marks[0].textContent).toBe('n')      // 预算内：只亮真正变化的字符
    expect(marks[marks.length - 1].textContent).toBe(line('n', 39)) // 预算耗尽：整行高亮
  })

  // --- spec §12 扩展：代码文件的语法着色 ---
  const codeData = {...data, oldContent: 'const a = 1', newContent: 'const a = 2'}

  it('代码文件 diff：出现语法着色类，且不顶掉增/删行的背景类', async () => {
    const {container} = render(<DiffViewer data={codeData} viewMode="side-by-side" />)
    await waitFor(() => expect(container.querySelector('.pm-tok-keyword')).not.toBeNull())
    expect(container.querySelectorAll('.pm-tok-keyword').length).toBeGreaterThanOrEqual(1)
    // 增/删语义仍由单元格背景承担：is-added / is-removed 必须还在
    const addedCode = container.querySelector('.pm-diff-code.is-added')
    const removedCode = container.querySelector('.pm-diff-code.is-removed')
    expect(addedCode).not.toBeNull()
    expect(removedCode).not.toBeNull()
    expect(addedCode!.querySelector('.pm-tok-keyword')).not.toBeNull()
    expect(removedCode!.querySelector('.pm-tok-keyword')).not.toBeNull()
    // 行文本无损
    expect(addedCode!.textContent).toBe('const a = 2')
    expect(removedCode!.textContent).toBe('const a = 1')
  })

  it('代码文件 diff：行背景与词级 mark 都没被着色 span 盖掉（无内联 style）', async () => {
    const {container} = render(<DiffViewer data={codeData} viewMode="side-by-side" />)
    await waitFor(() => expect(container.querySelector('.pm-tok-keyword')).not.toBeNull())
    const mark = container.querySelector('.pm-diff-word.is-added')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('2')
    // 变化的数字既被词级 mark 包住，也被语法着色 span 包住 —— 两个切分求交后都没丢
    expect(mark!.querySelector('.pm-tok-number')).not.toBeNull()
    expect(container.querySelectorAll('[style]').length).toBe(0)
  })

  it('词级 mark 与语法着色嵌套后，mark 仍只覆盖真正变化的片段（不被切碎也不吞掉）', () => {
    // 未变的 'const a = ' 不允许出现在任何 mark 里；变化的 '1'/'2' 必须完整落在 mark 里
    const {container} = render(<DiffViewer data={codeData} viewMode="side-by-side" />)
    for (const m of Array.from(container.querySelectorAll('.pm-diff-word'))) {
      expect(m.textContent).not.toContain('const')
      expect(m.textContent).not.toContain('a =')
    }
  })

  it('非代码文件 diff（.md）：不出现任何语法着色类', async () => {
    const mdData = {...data, filePath: 'notes.md', oldContent: '# 标题\n正文', newContent: '# 标题\n新正文'}
    const {container} = render(<DiffViewer data={mdData} viewMode="side-by-side" />)
    // 等待异步着色流程走完（结果为 null），再断言确实没有着色 DOM
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelectorAll('[class*="pm-tok-"]').length).toBe(0)
    // 原有渲染路径完好：该有的增删单元格与词级 mark 都在
    expect(container.querySelector('.pm-diff-code.is-added')).not.toBeNull()
    expect(container.querySelector('.pm-diff-word.is-added')).not.toBeNull()
  })

  it('.pm-tok-* 的 CSS 静态断言：8 个类都在 globals.css 且都引用 --code-* 令牌', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    const pairs: [string, string][] = [
      ['pm-tok-keyword', '--code-keyword'],
      ['pm-tok-string', '--code-string'],
      ['pm-tok-comment', '--code-comment'],
      ['pm-tok-number', '--code-number'],
      ['pm-tok-type', '--code-type'],
      ['pm-tok-function', '--code-function'],
      ['pm-tok-ident', '--code-ident'],
      ['pm-tok-punct', '--code-punct'],
    ]
    for (const [cls, token] of pairs) {
      const at = css.indexOf(`.${cls} {`)
      expect(at, `${cls} 规则缺失`).toBeGreaterThanOrEqual(0)
      const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
      expect(body, `${cls} 未复用 ${token}`).toContain(`var(${token})`)
    }
  })

  // ==========================================================================
  // side-by-side：IDEA 式「中线恒居中」布局（方案 A：块级层叠 + flex 行 + sticky 单元格）
  // 病灶：列宽是 max-content（内容驱动）→ 长行把左半栏撑宽，分界线被挤出可视区。
  // 改法：静止的两列（行号槽、中线）交给原生 position: sticky（合成线程逐帧精确，不存在
  // 「补偿量与原生动位移差一帧」→ 从结构上消除抖动）；只有代码内容 .pm-diff-line 保留
  // −max-sx 平移，靠滚动时间线 --pm-diff-h 把半栏裁掉的后半段拉出来。
  // ==========================================================================
  describe('side-by-side：中线恒居中 / 两侧裁剪 / sticky 静止 + 内容滚动时间线平移', () => {
    const CSS2 = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    /** 读 globals.css 里某个选择器的规则体（jsdom 不解析外部 CSS → 静态断言，同 EditorArea.test.tsx）。
        同一选择器可能出现多条规则（sbs 的单元格：sticky 一条、宽度一条）→ occurrence 取第 n 条 */
    function ruleBody(selector: string, occurrence = 0): string {
      let at = -1
      for (let i = 0; i <= occurrence; i++) {
        at = CSS2.indexOf(`\n${selector} {`, at + 1)
        expect(at, `globals.css 里找不到第 ${i + 1} 条规则 ${selector}`).toBeGreaterThan(-1)
      }
      const start = CSS2.indexOf('{', at)
      const end = CSS2.indexOf('}', start)
      return CSS2.slice(start + 1, end)
    }
    /** 含超长行（远超半栏宽）+ 增删不等，用来验证裁剪与对齐 */
    const longData = {
      ...data,
      filePath: 'long.ts',
      oldContent: `same\n${'x'.repeat(300)}\ntail-old`,
      newContent: `same\n${'y'.repeat(300)}\ntail-new\nonly-new`,
    }

    it('sbs 改为块级层叠：关掉 .pm-diff 的 4 列栅格，宽由内容撑开、窄于容器时铺满', () => {
      const body = ruleBody('.pm-diff--sbs')
      expect(body).toContain('display: block')
      expect(body).toContain('width: max-content')
      expect(body).toContain('min-width: 100%')
      // 栅格轨道已删除：列宽不再由 grid 承担（改由 flex 行 + sticky 单元格）
      expect(body).not.toContain('grid-template-columns')
    })

    it('行容器是 flex：行宽 = 最长行宽 + 半栏 + 行号槽 + 1px（即滚动范围，也是 sticky 的包含块）', () => {
      const body = ruleBody('.pm-diff--sbs .pm-diff-row')
      expect(body).toContain('display: flex')
      // 数值与原撑宽块公式一致，+1px 防取整把 sticky 提前夹住
      expect(body).toContain('calc(var(--pm-diff-content-w, 0px) + var(--pm-diff-half, 50%) + 49px)')
      expect(body).toContain('min-width: 100%')
    })

    it('静止的两列由原生 sticky 钉住：left = 各自不滚动时的自然位置（首帧不跳变）', () => {
      // 左行号槽：钉在滚动容器左缘
      const c1 = ruleBody('.pm-diff--sbs .pm-diff-row > :nth-child(1)')
      expect(c1).toContain('position: sticky')
      expect(c1).toContain('left: 0')
      // 左代码列：钉在左行号槽右侧（48px = 一个行号槽宽）
      const c2 = ruleBody('.pm-diff--sbs .pm-diff-row > :nth-child(2)')
      expect(c2).toContain('position: sticky')
      expect(c2).toContain('left: 48px')
      // 中线（右行号槽）钉在可视区 50%
      const c3 = ruleBody('.pm-diff--sbs .pm-diff-row > :nth-child(3)')
      expect(c3).toContain('position: sticky')
      expect(c3).toContain('left: var(--pm-diff-half, 50%)')
      // 右代码列钉在中线右侧一个行号槽宽处
      const c4 = ruleBody('.pm-diff--sbs .pm-diff-row > :nth-child(4)')
      expect(c4).toContain('position: sticky')
      expect(c4).toContain('left: calc(var(--pm-diff-half, 50%) + 48px)')
    })

    it('行号槽定宽 48px（两侧等宽 → 中线精确落在 50%）', () => {
      const body = ruleBody('.pm-diff--sbs .pm-diff-gutter')
      expect(body).toContain('flex: 0 0 48px')
      expect(body).toContain('overflow: hidden')
    })

    it('代码列宽由可视区几何决定：左 = 半栏 − 行号槽，右 = 可视区 − 半栏 − 行号槽', () => {
      // 同一选择器有两条规则（sticky 一条、宽度一条）→ 宽度规则是第 2 条
      expect(ruleBody('.pm-diff--sbs .pm-diff-row > :nth-child(2)', 1))
        .toContain('width: calc(var(--pm-diff-half, 50%) - 48px)')
      expect(ruleBody('.pm-diff--sbs .pm-diff-row > :nth-child(4)', 1))
        .toContain('width: calc(var(--pm-diff-view-w, 100%) - var(--pm-diff-half, 50%) - 48px)')
    })

    it('防回归：栅格反向平移与撑宽块已从 CSS 彻底移除（补偿路径不存在了）', () => {
      expect(CSS2).not.toContain('pm-diff-grid-x')
      expect(CSS2).not.toContain('pm-diff-sbs-spacer')
      expect(CSS2).not.toContain('grid-template-columns: 48px')
      // 旧 JS 补偿方案（--pm-diff-sx）不得再被任何规则消费：两套并存会互相覆盖
      expect(CSS2).not.toContain('var(--pm-diff-sx')
    })

    it('中线可见：每行第 3 格（右行号槽）带 1px 左边框，用 --border 令牌', () => {
      expect(ruleBody('.pm-diff--sbs .pm-diff-row > :nth-child(3)'))
        .toContain('border-left: 1px solid var(--border)')
    })

    it('内容平移保留：由具名滚动时间线驱动，−max-sx 把被半栏裁掉的后半段拉出来', () => {
      const line = ruleBody('.pm-diff--sbs .pm-diff-line')
      // animation 简写会重置 animation-timeline → 声明必须写在 animation 之后，否则时间线被清掉
      const lai = line.search(/animation:\s*pm-diff-line-x/)
      const lti = line.search(/animation-timeline:\s*--pm-diff-h/)
      expect(lai).toBeGreaterThanOrEqual(0)
      expect(lti).toBeGreaterThan(lai)
      // 具名时间线定义在滚动容器上（inline/unified 共用，额外声明无副作用）
      expect(ruleBody('.pm-diff-scroll')).toContain('scroll-timeline: --pm-diff-h inline')
      expect(CSS2).toContain('@keyframes pm-diff-line-x')
      expect(CSS2).toMatch(/pm-diff-line-x[\s\S]*?translateX\(calc\(-1 \* var\(--pm-diff-max-sx/)
    })

    it('两侧裁剪：代码单元格不定宽 + overflow: hidden + min-width: 0（否则被最长行顶宽，裁剪边界跑出半栏）', () => {
      const body = ruleBody('.pm-diff--sbs .pm-diff-code')
      expect(body).toContain('flex: 0 0 auto')
      expect(body).toContain('overflow: hidden')
      // 命门：flex item 的 min-width: auto 会被 max-content 行内容顶成「最长行那么宽」
      expect(body).toContain('min-width: 0')
    })

    it('DOM：行容器仍承载 4 个单元格（严格行对齐的结构前提），代码单元格内包一层 .pm-diff-line', () => {
      const {container} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
      const rows = Array.from(container.querySelectorAll('.pm-diff-row'))
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        const cells = Array.from(row.children)
        // 对齐保证：同一个 flex 行仍承载 4 个单元格（没有拆成左右两个面板）
        expect(cells.map(c => c.className.replace(/ is-\w+/g, '')))
          .toEqual(['pm-diff-gutter', 'pm-diff-code', 'pm-diff-gutter', 'pm-diff-code'])
        for (const cell of cells.filter(c => c.classList.contains('pm-diff-code'))) {
          // 裁剪 + 平移的载体：每个代码单元格恰好一个行内容块
          expect(cell.children.length).toBe(1)
          expect(cell.children[0].className).toBe('pm-diff-line')
        }
      }
      // 整份 diff 只有一个行容器集合：拆成两个就会丢掉「同一行承载 4 格」的对齐保证
      expect(container.querySelectorAll('.pm-diff--sbs').length).toBe(1)
      expect(container.querySelector('.pm-diff--sbs')!.querySelectorAll('.pm-diff-row').length).toBe(rows.length)
      // 左右各一行内容块，一个不多一个不少
      expect(container.querySelectorAll('.pm-diff-line').length).toBe(rows.length * 2)
    })

    it('滚动容器里只有 .pm-diff--sbs 一个子元素（撑宽块已删除，首个子元素契约不破）', () => {
      const {container} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
      const scroller = container.querySelector('.pm-diff-scroll')!
      expect(scroller.firstElementChild).toBe(screen.getByTestId('diff-side-by-side'))
      expect(scroller.lastElementChild).toBe(screen.getByTestId('diff-side-by-side'))
      expect(scroller.children.length).toBe(1)
    })

    it('原生滚动不再由 JS 补偿：滚动不写任何内联变量（改由 CSS 滚动时间线承担，无差帧）', () => {
      const {container} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
      const scroller = container.querySelector<HTMLElement>('.pm-diff-scroll')!
      // 滚动时间线定义在滚动容器上 → 沿继承下发到两侧所有 .pm-diff-line
      expect(container.querySelector('.pm-diff--sbs')!.closest('.pm-diff-scroll')).toBe(scroller)
      const spy = vi.spyOn(scroller.style, 'setProperty')
      scroller.scrollLeft = 120
      fireEvent.scroll(scroller)
      scroller.scrollLeft = 0
      fireEvent.scroll(scroller)
      // 旧的 scroll 监听会把 scrollLeft 写进 --pm-diff-sx；新方案主线程不参与滚动路径
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('jsdom 安全：无布局（offsetWidth 恒 0）时不写内联样式，也不产生滚动范围', () => {
      const {container} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
      const scroller = container.querySelector<HTMLElement>('.pm-diff-scroll')!
      expect(scroller.getAttribute('style')).toBeNull()
      expect(container.querySelectorAll('[style]').length).toBe(0)
    })

    it('可视区几何写进 --pm-diff-view-w / --pm-diff-half（整型 px，取整），无布局时不写', () => {
      const {container, rerender} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
      const scroller = container.querySelector<HTMLElement>('.pm-diff-scroll')!
      // 无布局的初测：clientWidth 在 jsdom 里也是 0 → 两个变量都不该出现
      expect(scroller.style.getPropertyValue('--pm-diff-view-w')).toBe('')
      expect(scroller.style.getPropertyValue('--pm-diff-half')).toBe('')
      const lines = Array.from(container.querySelectorAll<HTMLElement>('.pm-diff-line'))
      Object.defineProperty(lines[0], 'offsetWidth', {value: 900, configurable: true})
      Object.defineProperty(scroller, 'clientWidth', {value: 1001.6, configurable: true})
      rerender(<DiffViewer data={{...longData}} viewMode="side-by-side" />)
      expect(scroller.style.getPropertyValue('--pm-diff-view-w')).toBe('1002px')
      expect(scroller.style.getPropertyValue('--pm-diff-half')).toBe('501px')
      // 内容归零 → 与其余变量一起清掉，不留残余布局值
      Object.defineProperty(lines[0], 'offsetWidth', {value: 0, configurable: true})
      rerender(<DiffViewer data={{...longData}} viewMode="side-by-side" />)
      expect(scroller.style.getPropertyValue('--pm-diff-view-w')).toBe('')
      expect(scroller.style.getPropertyValue('--pm-diff-half')).toBe('')
    })

    it('最长行宽度写进 --pm-diff-content-w（mock 几何：取所有行内容块的最大宽度）', () => {
      const {container, rerender} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
      const scroller = container.querySelector<HTMLElement>('.pm-diff-scroll')!
      const lines = Array.from(container.querySelectorAll<HTMLElement>('.pm-diff-line'))
      expect(lines.length).toBeGreaterThanOrEqual(2)
      Object.defineProperty(lines[0], 'offsetWidth', {value: 400, configurable: true})
      Object.defineProperty(lines[1], 'offsetWidth', {value: 900, configurable: true})
      // 换新的 data 对象 → 重新测量（真实场景里是切文件 / 着色片段到达时重测）
      rerender(<DiffViewer data={{...longData}} viewMode="side-by-side" />)
      expect(scroller.style.getPropertyValue('--pm-diff-content-w')).toBe('900px')
      // 再切到「没有任何宽度」的 diff：必须清掉旧宽度，否则留下幽灵横向滚动条
      Object.defineProperty(lines[0], 'offsetWidth', {value: 0, configurable: true})
      Object.defineProperty(lines[1], 'offsetWidth', {value: 0, configurable: true})
      rerender(<DiffViewer data={{...longData}} viewMode="side-by-side" />)
      expect(scroller.style.getPropertyValue('--pm-diff-content-w')).toBe('')
    })

    it('横向滚动范围写进 --pm-diff-max-sx（mock 几何：scrollWidth − clientWidth），无范围/无内容时清掉', () => {
      const {container, rerender} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
      const scroller = container.querySelector<HTMLElement>('.pm-diff-scroll')!
      const lines = Array.from(container.querySelectorAll<HTMLElement>('.pm-diff-line'))
      Object.defineProperty(lines[0], 'offsetWidth', {value: 900, configurable: true})
      Object.defineProperty(scroller, 'scrollWidth', {value: 1400, configurable: true})
      Object.defineProperty(scroller, 'clientWidth', {value: 1000, configurable: true})
      rerender(<DiffViewer data={{...longData}} viewMode="side-by-side" />)
      expect(scroller.style.getPropertyValue('--pm-diff-content-w')).toBe('900px')
      // 几何变量（content-w / view-w / half）落地、行宽生效后，读 scrollWidth − clientWidth 作终点
      expect(scroller.style.getPropertyValue('--pm-diff-max-sx')).toBe('400px')
      // 内容归零 → 两个变量都必须清掉（否则 keyframes 终点残留，内容会停在旧位移）
      Object.defineProperty(lines[0], 'offsetWidth', {value: 0, configurable: true})
      rerender(<DiffViewer data={{...longData}} viewMode="side-by-side" />)
      expect(scroller.style.getPropertyValue('--pm-diff-content-w')).toBe('')
      expect(scroller.style.getPropertyValue('--pm-diff-max-sx')).toBe('')
    })

    it('滚动容器尺寸变化（ResizeObserver）时重测 --pm-diff-max-sx，卸载时 disconnect', () => {
      let cb: ResizeObserverCallback | null = null
      const observe = vi.fn()
      const disconnect = vi.fn()
      const RO = vi.fn(function (this: unknown, c: ResizeObserverCallback) {
        cb = c
        return {observe, unobserve: vi.fn(), disconnect}
      })
      vi.stubGlobal('ResizeObserver', RO)
      try {
        const {container, unmount} = render(<DiffViewer data={longData} viewMode="side-by-side" />)
        const scroller = container.querySelector<HTMLElement>('.pm-diff-scroll')!
        expect(RO).toHaveBeenCalled()
        expect(observe).toHaveBeenCalledWith(scroller)
        // 尺寸变化后重新测量（例如纵向滚动条出现 → 可视区变窄 → 滚动范围变大）
        const lines = Array.from(container.querySelectorAll<HTMLElement>('.pm-diff-line'))
        Object.defineProperty(lines[0], 'offsetWidth', {value: 900, configurable: true})
        Object.defineProperty(scroller, 'scrollWidth', {value: 1500, configurable: true})
        Object.defineProperty(scroller, 'clientWidth', {value: 1000, configurable: true})
        act(() => { cb!([], {} as ResizeObserver) })
        expect(scroller.style.getPropertyValue('--pm-diff-max-sx')).toBe('500px')
        unmount()
        expect(disconnect).toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('inline / unified 完全不受影响：无行内容块、无撑宽块、无内联样式', () => {
      for (const mode of ['inline', 'unified'] as const) {
        const {container, unmount} = render(<DiffViewer data={longData} viewMode={mode} />)
        expect(container.querySelector('.pm-diff--inline')).not.toBeNull()
        expect(container.querySelector('.pm-diff--sbs')).toBeNull()
        expect(container.querySelector('.pm-diff-line')).toBeNull()
        expect(container.querySelectorAll('[style]').length).toBe(0)
        // 单列分支的既有能力仍在（行标记 + 词级高亮）
        expect(container.querySelector('.pm-diff-word.is-added')).not.toBeNull()
        unmount()
      }
    })
  })
})

// ==========================================================================
// 按行选中（IDEA 风格）：与 CodeEditor 语义一致，选区以「行索引集合 + 所属侧」为事实源
// ==========================================================================
describe('DiffViewer 按行选中', () => {
  const data = {
    filePath: 'a.ts', oldContent: 'line1\nline2', newContent: 'line1\nline2 changed',
    diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'worktree', additions: 1, deletions: 1,
  }
  const multi = {
    ...data,
    oldContent: 'a\nb\nc\nd',
    newContent: 'a\nB\nC\nd',
  }
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })
  const codeCell = (container: HTMLElement, side: 'left' | 'right', row: number) =>
    container.querySelector<HTMLElement>(`.pm-diff-code[data-side="${side}"][data-row="${row}"]`)!
  const gutter = (container: HTMLElement, side: 'left' | 'right', row: number) =>
    container.querySelector<HTMLElement>(`.pm-diff-gutter[data-side="${side}"][data-row="${row}"]`)!

  it('单击某一栏的某行 → 该侧整行（代码单元格 + 行号槽）高亮，另一侧不高亮', () => {
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 1), {button: 0})
    expect(codeCell(container, 'left', 1).classList.contains('is-selected')).toBe(true)
    expect(gutter(container, 'left', 1).classList.contains('is-selected')).toBe(true)
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(1)
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-gutter.is-selected').length).toBe(1)
    expect(codeCell(container, 'right', 1).classList.contains('is-selected')).toBe(false)
  })

  it('在另一侧开始选择 → 清空原侧（同一时刻只有一侧有选区）', () => {
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 1), {button: 0})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(1)
    fireEvent.mouseDown(codeCell(container, 'right', 1), {button: 0})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(1)
    expect(codeCell(container, 'right', 1).classList.contains('is-selected')).toBe(true)
    expect(codeCell(container, 'left', 1).classList.contains('is-selected')).toBe(false)
  })

  it('Ctrl/Cmd + 单击 → 切换单行（非连续跨行加选/减选）', () => {
    const {container} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    fireEvent.mouseDown(codeCell(container, 'left', 2), {button: 0, ctrlKey: true})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(2)
    expect(codeCell(container, 'left', 0).classList.contains('is-selected')).toBe(true)
    expect(codeCell(container, 'left', 2).classList.contains('is-selected')).toBe(true)
    // 再 Ctrl 点一次 → 减选
    fireEvent.mouseDown(codeCell(container, 'left', 2), {button: 0, metaKey: true})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(1)
  })

  it('Shift + 单击 → 锚点行到目标行的区间选（替换）', () => {
    const {container} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    fireEvent.mouseDown(codeCell(container, 'left', 3), {button: 0, shiftKey: true})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(4)
    for (const row of [0, 1, 2, 3]) {
      expect(codeCell(container, 'left', row).classList.contains('is-selected')).toBe(true)
    }
  })

  it('拖动 → 起点行到当前行连续扩选', () => {
    const {container} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    fireEvent.mouseMove(codeCell(container, 'left', 2), {buttons: 1})
    fireEvent.mouseUp(document)
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(3)
  })

  // --- M1 回归：右键不得起选 / 不得启动拖动 ---
  it('右键（button !== 0）不起选、不启动拖动', () => {
    const {container} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 1), {button: 2})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(0)
    // 右键未启动拖动：即便随后左键位移动，也不得产生任何选区
    fireEvent.mouseMove(codeCell(container, 'left', 3), {buttons: 1})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(0)
  })

  it('拖动中松开左键（buttons 无左键位）后 mousemove 不再扩选', () => {
    const {container} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    fireEvent.mouseMove(codeCell(container, 'left', 2), {buttons: 1})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(3)
    // 左键已松开：buttons=0 的 mousemove 不得继续扩选
    fireEvent.mouseMove(codeCell(container, 'left', 1), {buttons: 0})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(3)
  })

  // --- M3 回归：切 diff 文件时选区 / 拖动态必须收敛 ---
  it('切 diff 文件：选区清空（行索引语义随行模型失效）', () => {
    const next = {...multi, filePath: 'b.ts', oldContent: 'p\nq\nr\ns', newContent: 'p\nQ\nR\ns'}
    const {container, rerender} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(1)
    rerender(<DiffViewer data={next} viewMode="side-by-side" />)
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(0)
  })

  it('拖动中切 diff 文件：结束拖动，后续 mousemove 不再写入新文件选区', () => {
    const next = {...multi, filePath: 'b.ts', oldContent: 'p\nq\nr\ns', newContent: 'p\nQ\nR\ns'}
    const {container, rerender} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    // 启动拖动（按下左键、尚未 mouseup）
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    rerender(<DiffViewer data={next} viewMode="side-by-side" />)
    // 若未 endDrag，残留的 document mousemove 监听会用旧锚点往新文件的行索引上写选区
    fireEvent.mouseMove(codeCell(container, 'left', 3), {buttons: 1})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(0)
  })

  it('Ctrl/Cmd+A 全选当前侧、Esc 清除选区', () => {
    const {container} = render(<DiffViewer data={multi} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    fireEvent.keyDown(document, {key: 'a', ctrlKey: true})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(4)
    fireEvent.keyDown(document, {key: 'Escape'})
    expect(container.querySelectorAll('.pm-diff--sbs .pm-diff-code.is-selected').length).toBe(0)
  })

  it('Ctrl/Cmd+C 复制该侧纯文本（不含行号，\\n 连接）', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" />)
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    fireEvent.mouseDown(codeCell(container, 'left', 1), {button: 0, shiftKey: true})
    fireEvent.keyDown(document, {key: 'c', ctrlKey: true})
    expect(writeText).toHaveBeenCalledWith('line1\nline2')
    // 右（新增）侧复制的是新文本
    writeText.mockClear()
    fireEvent.mouseDown(codeCell(container, 'right', 1), {button: 0})
    fireEvent.keyDown(document, {key: 'c', metaKey: true})
    expect(writeText).toHaveBeenCalledWith('line2 changed')
  })

  it('inline 模式：单击选整行，复制保留 +/-/空格 前缀', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})
    const {container} = render(<DiffViewer data={data} viewMode="inline" />)
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.pm-diff-inline-row'))
    const addRow = rows.find(r => r.getAttribute('data-testid') === 'diff-line-added')!
    fireEvent.mouseDown(addRow, {button: 0})
    expect(addRow.classList.contains('is-selected')).toBe(true)
    fireEvent.keyDown(document, {key: 'c', ctrlKey: true})
    expect(writeText).toHaveBeenCalledWith('+line2 changed')
  })

  it('虚拟化：选区随行索引保存，滚出视口再滚回后仍高亮（不依赖 DOM 节点存活）', async () => {
    const big = {
      ...data,
      filePath: 'big.ts',
      oldContent: Array.from({length: 100}, (_, i) => `old-${i}`).join('\n'),
      newContent: Array.from({length: 100}, (_, i) => `new-${i}`).join('\n'),
    }
    const {container} = render(<DiffViewer data={big} viewMode="side-by-side" />)
    const scroller = container.querySelector<HTMLElement>('.pm-diff-scroll')!
    Object.defineProperty(scroller, 'clientHeight', {value: 100, configurable: true})
    // 先选中第 0 行左侧
    fireEvent.mouseDown(codeCell(container, 'left', 0), {button: 0})
    expect(codeCell(container, 'left', 0).classList.contains('is-selected')).toBe(true)
    // 滚到底部 → 第 0 行被虚拟化剔除
    Object.defineProperty(scroller, 'scrollTop', {value: 95 * 20, writable: true, configurable: true})
    fireEvent.scroll(scroller)
    await waitFor(() => {
      expect(container.querySelectorAll('.pm-diff-row').length).toBeLessThan(100)
      expect(codeCell(container, 'left', 0)).toBeNull()
    })
    // 滚回顶部 → 第 0 行重新渲染，且仍带 is-selected（选区按索引恢复）
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    await waitFor(() => {
      expect(container.querySelector('.pm-diff-code[data-side="left"][data-row="0"]')).not.toBeNull()
    })
    expect(codeCell(container, 'left', 0).classList.contains('is-selected')).toBe(true)
  })
})
// 追加：选区快照外发。回调形态用结构化内联类型，无需新增 import。
type Snap = {side: string, lineNumbers: number[], sendable: boolean, reason?: string} | null

describe('DiffViewer 选区快照外发（onSelectionChange）', () => {
  const data = {
    filePath: 'a.ts', oldContent: 'line1\nline2', newContent: 'line1\nline2 changed',
    diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'worktree', additions: 1, deletions: 1,
  }
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('左栏（旧版本）选区：sendable=false 且带不可发送原因', () => {
    const seen: Snap[] = []
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" onSelectionChange={s => seen.push(s)} />)
    const cell = container.querySelector<HTMLElement>('.pm-diff-code[data-side="left"][data-row="0"]')!
    fireEvent.mouseDown(cell, {button: 0})
    const last = seen[seen.length - 1]
    expect(last).toMatchObject({side: 'left', sendable: false, reason: '仅新版本行可发送'})
    expect(last!.lineNumbers).toEqual([1])
  })

  it('右栏（新版本）选区：sendable=true 且行号取 newNo', () => {
    const seen: Snap[] = []
    const {container} = render(<DiffViewer data={data} viewMode="side-by-side" onSelectionChange={s => seen.push(s)} />)
    const cell = container.querySelector<HTMLElement>('.pm-diff-code[data-side="right"][data-row="0"]')!
    fireEvent.mouseDown(cell, {button: 0})
    const last = seen[seen.length - 1]
    expect(last).toMatchObject({side: 'right', sendable: true})
    expect(last!.lineNumbers).toEqual([1])
  })

  it('inline 选中删除行：sendable=false、行号为空、带原因', () => {
    const seen: Snap[] = []
    const {container} = render(<DiffViewer data={data} viewMode="inline" onSelectionChange={s => seen.push(s)} />)
    const del = container.querySelector<HTMLElement>('[data-testid="diff-line-deleted"]')!
    fireEvent.mouseDown(del, {button: 0})
    expect(seen[seen.length - 1]).toMatchObject({side: 'inline', sendable: false, reason: '删除行不可发送', lineNumbers: []})
  })

  it('inline 混合选区（del + add）：过滤掉 del 行，只留新版本行号', () => {
    const seen: Snap[] = []
    const {container} = render(<DiffViewer data={data} viewMode="inline" onSelectionChange={s => seen.push(s)} />)
    // inlineRows 顺序：0=context、1=del(line2 旧)、2=add(line2 新)
    const rowAt = (i: number) => container.querySelector<HTMLElement>(`.pm-diff-inline-row[data-row="${i}"]`)!
    fireEvent.mouseDown(rowAt(1), {button: 0})
    fireEvent.mouseDown(rowAt(2), {button: 0, ctrlKey: true})
    const last = seen[seen.length - 1]
    expect(last).toMatchObject({side: 'inline', sendable: true})
    expect(last!.lineNumbers).toEqual([2])
  })

  it('side-by-side 空白槽位：对侧无内容（无行号）→ 过滤后为空、sendable=false', () => {
    // 旧多新少：末行是 del，其右侧单元格是空槽（newNo 为 undefined）
    const uneven = {
      filePath: 'a.ts', oldContent: 'a\nb\nc', newContent: 'a\nb',
      diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'worktree', additions: 0, deletions: 1,
    }
    const seen: Snap[] = []
    const {container} = render(<DiffViewer data={uneven} viewMode="side-by-side" onSelectionChange={s => seen.push(s)} />)
    const rowEls = container.querySelectorAll('.pm-diff-row')
    const lastRow = rowEls[rowEls.length - 1]!
    const rightCell = lastRow.querySelector<HTMLElement>('.pm-diff-code[data-side="right"]')!
    fireEvent.mouseDown(rightCell, {button: 0})
    expect(seen[seen.length - 1]).toMatchObject({side: 'right', sendable: false, lineNumbers: []})
  })

  it('切换视图模式清空选区 → 外发 null（上层据此收起菜单）', () => {
    const seen: Snap[] = []
    const {container, rerender} = render(<DiffViewer data={data} viewMode="side-by-side" onSelectionChange={s => seen.push(s)} />)
    fireEvent.mouseDown(container.querySelector<HTMLElement>('.pm-diff-code[data-side="right"][data-row="0"]')!, {button: 0})
    expect(seen[seen.length - 1]).not.toBeNull()
    rerender(<DiffViewer data={data} viewMode="inline" onSelectionChange={s => seen.push(s)} />)
    expect(seen[seen.length - 1]).toBeNull()
  })

  it('切换 diff 文件：不得先外发「新行模型 + 旧索引」的错值快照（I1 回归）', () => {
    const seen: Snap[] = []
    const {container, rerender} = render(<DiffViewer data={data} viewMode="side-by-side" onSelectionChange={s => seen.push(s)} />)
    fireEvent.mouseDown(container.querySelector<HTMLElement>('.pm-diff-code[data-side="right"][data-row="0"]')!, {button: 0})
    expect(seen[seen.length - 1]).toMatchObject({side: 'right', sendable: true})
    const n = seen.length
    // 同形状、不同内容的 data：旧选区索引（0）在新行模型里语义已失效
    const next = {...data, newContent: 'line1\nline2 renamed'}
    rerender(<DiffViewer data={next} viewMode="side-by-side" onSelectionChange={s => seen.push(s)} />)
    // 切换后新增的每一次外发都必须是 null，绝不能出现任何 sendable===true 的错值快照
    expect(seen.slice(n).length).toBeGreaterThan(0)
    expect(seen.slice(n).every(s => s === null)).toBe(true)
  })
})
