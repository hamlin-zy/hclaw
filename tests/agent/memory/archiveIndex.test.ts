import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import fs from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {createHash} from 'crypto'
import {
  ARCHIVE_INDEX_DEFAULTS,
  buildArchiveIndex,
  clearArchiveIndexCache,
  extractArchiveSummary,
  toArchiveVolumeName,
} from '../../../src/main/agent/memory/archiveIndex'

describe('extractArchiveSummary', () => {
  it('优先取 > 摘要：行', () => {
    expect(extractArchiveSummary('> 摘要：双引号坑与转义\n# 旧标题', '2026-09-x.md', 20)).toBe('双引号坑与转义')
  })
  it('回落 H1 并清洗（剥前缀/日期/尾部括号/专项）', () => {
    expect(extractArchiveSummary('# 归档卷：2026-09 记忆管理窗口专项（细节原文）', '2026-09-x.md', 20)).toBe('记忆管理窗口')
  })
  it('无 H1 时回落卷名', () => {
    expect(extractArchiveSummary('', '2026-09-runtime-pitfalls.md', 20)).toBe('runtime-pitfalls')
  })
  it('maxChars 截断并补省略号', () => {
    expect(extractArchiveSummary('# 一二三四五六七八九十一二三四五六七八九十', 'x.md', 5)).toBe('一二三四五…')
  })
  it('不切断代理对（emoji）', () => {
    const out = extractArchiveSummary('# 😀😀😀😀', 'x.md', 3)
    expect(out).toBe('😀😀😀…')
    expect(out.includes('\uFFFD')).toBe(false)
  })
  it('> 归档卷： 不误判为摘要行', () => {
    expect(extractArchiveSummary('> 归档卷：不注入会话，按需查阅\n# 发布工作流细节（2026-09）', '2026-09-release.md', 20)).toBe('发布工作流细节')
  })
})

describe('toArchiveVolumeName', () => {
  it('去 .md 与 yyyy-MM- 前缀且保留连字符', () => {
    expect(toArchiveVolumeName('2026-09-opencode免费层与代理风险.md')).toBe('opencode免费层与代理风险')
    expect(toArchiveVolumeName('patterns.md')).toBe('patterns')
  })
})

/** 一天的毫秒数 */
const DAY = 86_400_000
/** mtime 基准（固定值，避免依赖真实时间导致断言漂移） */
const BASE_MTIME = Date.UTC(2026, 8, 1)
/** 测试用 workspace 路径（只作为 index.json 的键，不要求真实存在） */
const WS = 'E:\\proj\\demo'

/** 当前用例的临时 hclawDir */
let root = ''

function refDir(hclawDir: string): string {
  return join(hclawDir, 'mem', 'ref')
}

/** 跨项目归档目录 mem/ref/_user/archive */
function crossArchiveDir(hclawDir: string): string {
  return join(refDir(hclawDir), '_user', 'archive')
}

/** 项目归档目录 mem/ref/<dir>/archive */
function projectArchiveDir(hclawDir: string, dir: string): string {
  return join(refDir(hclawDir), dir, 'archive')
}

/** 写 index.json（父目录不存在则创建） */
function writeIndex(hclawDir: string, index: Record<string, {dir: string; projectName: string}>): void {
  fs.mkdirSync(refDir(hclawDir), {recursive: true})
  fs.writeFileSync(join(refDir(hclawDir), 'index.json'), JSON.stringify(index), 'utf8')
}

/** 写一个归档卷，并把 mtime 固定为指定毫秒值 */
function writeVolume(dir: string, fileName: string, summary: string, mtimeMs: number): string {
  fs.mkdirSync(dir, {recursive: true})
  const filePath = join(dir, fileName)
  fs.writeFileSync(filePath, `# 归档卷：${fileName}\n\n> 摘要：${summary}\n\n正文\n`, 'utf8')
  fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs))
  return filePath
}

/** 与实现一致的展示用目录（正斜杠 + 尾斜杠） */
function displayDir(absDir: string): string {
  return `${absDir.replace(/\\/g, '/')}/`
}

/** body 拆行，便于断言整行（避免前缀误匹配） */
function linesOf(body: string): string[] {
  return body.split('\n')
}

/** 只保留条目行（- 开头） */
function entryLines(body: string): string[] {
  return linesOf(body).filter((line) => line.startsWith('- '))
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'hclaw-archive-'))
  clearArchiveIndexCache()
})

afterEach(() => {
  clearArchiveIndexCache()
  fs.rmSync(root, {recursive: true, force: true})
})

describe('ARCHIVE_INDEX_DEFAULTS', () => {
  it('默认预算逐字固定', () => {
    expect(ARCHIVE_INDEX_DEFAULTS).toEqual({maxBytes: 3072, summaryMaxChars: 20, recentKeep: 15})
  })
})

describe('buildArchiveIndex', () => {
  it('跨项目 2 卷 + 项目 1 卷：两段标题、三行条目与摘要', () => {
    writeVolume(crossArchiveDir(root), '2026-08-runtime-pitfalls.md', '运行时与流式坑', BASE_MTIME + DAY)
    writeVolume(crossArchiveDir(root), '2026-09-release.md', '发布流程', BASE_MTIME + DAY * 2)
    writeVolume(projectArchiveDir(root, 'hclaw'), '2026-09-selection.md', '选区抑制', BASE_MTIME + DAY * 3)
    writeIndex(root, {[WS]: {dir: 'hclaw', projectName: 'hclaw'}})

    const res = buildArchiveIndex({hclawDir: root, workspacePath: WS})
    expect(res).not.toBeNull()
    const body = res!.body

    expect(body).toContain('## 跨项目归档卷（跨项目通用经验）')
    expect(body).toContain(`目录：${displayDir(crossArchiveDir(root))}`)
    expect(body).toContain('## 本项目归档卷（hclaw）')
    expect(body).toContain(`目录：${displayDir(projectArchiveDir(root, 'hclaw'))}`)
    expect(entryLines(body)).toEqual([
      '- release：发布流程',
      '- runtime-pitfalls：运行时与流式坑',
      '- selection：选区抑制',
    ])
    expect(res!.truncated).toBe(false)
    expect(res!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(res!.digest).toBe(createHash('sha256').update(body, 'utf8').digest('hex'))
  })

  it('workspace 未登记 index.json：只出跨项目段（项目段标题与目录行都不出现）', () => {
    writeVolume(crossArchiveDir(root), '2026-09-release.md', '发布流程', BASE_MTIME + DAY)
    // 另一条登记项存在，但当前 workspace 不在其中
    writeVolume(projectArchiveDir(root, 'hclaw'), '2026-09-selection.md', '选区抑制', BASE_MTIME + DAY * 2)
    writeIndex(root, {'E:\\proj\\other': {dir: 'hclaw', projectName: 'hclaw'}})

    const res = buildArchiveIndex({hclawDir: root, workspacePath: WS})
    expect(res).not.toBeNull()
    expect(res!.body).toContain('- release：发布流程')
    expect(res!.body).not.toContain('本项目归档卷')
    expect(res!.body).not.toContain('selection')
    expect(res!.body).not.toContain(displayDir(projectArchiveDir(root, 'hclaw')))
  })

  it('workspace 已登记但项目 archive 目录不存在：项目段整段省略且不抛错', () => {
    writeVolume(crossArchiveDir(root), '2026-09-release.md', '发布流程', BASE_MTIME + DAY)
    writeIndex(root, {[WS]: {dir: 'hclaw', projectName: 'hclaw'}})

    const res = buildArchiveIndex({hclawDir: root, workspacePath: WS})
    expect(res).not.toBeNull()
    expect(res!.body).toContain('- release：发布流程')
    expect(res!.body).not.toContain('本项目归档卷')
    expect(res!.body).not.toContain('hclaw/archive')
  })

  it('两级都无卷：返回 null', () => {
    // 连 mem/ 都没有
    expect(buildArchiveIndex({hclawDir: root, workspacePath: WS})).toBeNull()
    // 归档目录存在但为空
    fs.mkdirSync(crossArchiveDir(root), {recursive: true})
    expect(buildArchiveIndex({hclawDir: root, workspacePath: WS})).toBeNull()
    expect(buildArchiveIndex({hclawDir: root, workspacePath: null})).toBeNull()
  })

  it('条目按 mtimeMs 倒序，同 mtime 按文件名升序', () => {
    const sameMtime = BASE_MTIME + DAY
    // 同 mtime 的两个卷：原始文件名 2026-01-vol-b.md < vol-a.md（按文件名升序）
    writeVolume(crossArchiveDir(root), '2026-01-vol-b.md', '旧卷一', sameMtime)
    writeVolume(crossArchiveDir(root), 'vol-a.md', '旧卷二', sameMtime)
    writeVolume(crossArchiveDir(root), '2026-09-newest.md', '最新卷', sameMtime + 60000)

    const res = buildArchiveIndex({hclawDir: root, workspacePath: null})
    expect(entryLines(res!.body)).toEqual(['- newest：最新卷', '- vol-b：旧卷一', '- vol-a：旧卷二'])
  })

  it('超预算：truncated 为 true，最近 K 卷仍带摘要、其余仅卷名，且不超预算', () => {
    const longSummary = '这是一段明显超过二十个字符的摘要用于触发逐卷降级'
    const truncatedSummary = Array.from(longSummary).slice(0, 20).join('') + '…'
    for (let i = 1; i <= 30; i++) {
      const no = String(i).padStart(2, '0')
      writeVolume(crossArchiveDir(root), `2026-09-vol-${no}.md`, longSummary, BASE_MTIME + i * 60000)
    }
    writeVolume(projectArchiveDir(root, 'hclaw'), '2026-09-selection.md', '选区抑制', BASE_MTIME)
    writeIndex(root, {[WS]: {dir: 'hclaw', projectName: 'hclaw'}})

    const res = buildArchiveIndex({hclawDir: root, workspacePath: WS})
    expect(res).not.toBeNull()
    expect(res!.truncated).toBe(true)
    expect(Buffer.byteLength(res!.body, 'utf8')).toBeLessThanOrEqual(ARCHIVE_INDEX_DEFAULTS.maxBytes)

    const lines = linesOf(res!.body)
    // 阶段 1 逐卷降级：最新的 vol-30 仍带摘要
    expect(lines).toContain(`- vol-30：${truncatedSummary}`)
    // 更旧的卷退化为仅卷名
    expect(lines).toContain('- vol-01')
    expect(lines.some((line) => line.startsWith('- vol-01：'))).toBe(false)
  })

  it('自然长度恰等于 maxBytes：不退化，truncated 为 false', () => {
    writeVolume(crossArchiveDir(root), '2026-09-cross.md', '跨项目总结', BASE_MTIME + DAY)
    for (let i = 1; i <= 4; i++) {
      writeVolume(
        projectArchiveDir(root, 'hclaw'),
        `2026-09-proj-${i}.md`,
        '项目卷摘要内容占位填充甲乙丙丁',
        BASE_MTIME + DAY + i * 60000,
      )
    }
    writeIndex(root, {[WS]: {dir: 'hclaw', projectName: 'hclaw'}})

    // 先取「自然长度」形态（预算足够大 → 任何一级都不降级）
    const natural = buildArchiveIndex({hclawDir: root, workspacePath: WS, limits: {maxBytes: 100000}})
    expect(natural).not.toBeNull()
    expect(natural!.truncated).toBe(false)
    const exact = Buffer.byteLength(natural!.body, 'utf8')

    const res = buildArchiveIndex({hclawDir: root, workspacePath: WS, limits: {maxBytes: exact}})
    expect(res!.truncated).toBe(false)
    expect(res!.body).toBe(natural!.body)
    expect(Buffer.byteLength(res!.body, 'utf8')).toBe(exact)
  })

  it('缓存：第二次零读盘，卷 mtime 变化后击穿', () => {
    writeVolume(crossArchiveDir(root), '2026-09-cross.md', '跨项目总结', BASE_MTIME + DAY)
    writeVolume(projectArchiveDir(root, 'hclaw'), '2026-09-proj.md', '项目总结', BASE_MTIME + DAY * 2)
    writeIndex(root, {[WS]: {dir: 'hclaw', projectName: 'hclaw'}})
    const opts = {hclawDir: root, workspacePath: WS}

    const spy = vi.spyOn(fs, 'openSync')
    const first = buildArchiveIndex(opts)
    expect(spy.mock.calls.length).toBeGreaterThan(0)

    spy.mockClear()
    const second = buildArchiveIndex(opts)
    expect(spy.mock.calls.length).toBe(0)
    expect(second!.body).toBe(first!.body)
    spy.mockRestore()

    // 卷内容与 mtime 变化 → 缓存键变化 → 必须重新读盘
    writeVolume(projectArchiveDir(root, 'hclaw'), '2026-09-proj.md', '项目总结已更新', BASE_MTIME + DAY * 9)
    const third = buildArchiveIndex(opts)
    expect(entryLines(third!.body)).toContain('- proj：项目总结已更新')
  })

  it('卷被删除后再次调用：条目不残留、不抛错', () => {
    const gone = writeVolume(crossArchiveDir(root), '2026-09-gone.md', '待删除', BASE_MTIME + DAY)
    writeVolume(crossArchiveDir(root), '2026-09-keep.md', '保留', BASE_MTIME + DAY * 2)

    const before = buildArchiveIndex({hclawDir: root, workspacePath: null})
    expect(entryLines(before!.body)).toContain('- gone：待删除')

    fs.rmSync(gone)
    const after = buildArchiveIndex({hclawDir: root, workspacePath: null})
    expect(after).not.toBeNull()
    expect(after!.body).not.toContain('gone')
    expect(entryLines(after!.body)).toEqual(['- keep：保留'])
  })

  it('扫描期间某卷不可读（如并发删除）：跳过该卷且不抛错', () => {
    writeVolume(crossArchiveDir(root), '2026-09-bad.md', '坏卷', BASE_MTIME + DAY)
    writeVolume(crossArchiveDir(root), '2026-09-ok.md', '好卷', BASE_MTIME + DAY * 2)

    const realOpenSync = fs.openSync
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path).includes('bad')) throw new Error('ENOENT: 模拟并发删除')
      return (realOpenSync as (...args: unknown[]) => number)(path, ...rest)
    }) as typeof fs.openSync)

    try {
      const res = buildArchiveIndex({hclawDir: root, workspacePath: null})
      expect(res).not.toBeNull()
      expect(entryLines(res!.body)).toEqual(['- ok：好卷'])
    } finally {
      spy.mockRestore()
    }
  })

  it('极小预算：按码点硬截断，不出现 U+FFFD 且不超预算', () => {
    writeVolume(crossArchiveDir(root), '2026-09-huge.md', '超长摘要内容'.repeat(20), BASE_MTIME + DAY)
    const res = buildArchiveIndex({
      hclawDir: root,
      workspacePath: null,
      limits: {maxBytes: 50, summaryMaxChars: 200},
    })

    expect(res).not.toBeNull()
    expect(res!.truncated).toBe(true)
    expect(Buffer.byteLength(res!.body, 'utf8')).toBeLessThanOrEqual(50)
    expect(res!.body.includes('\uFFFD')).toBe(false)
    expect(res!.body.length).toBeGreaterThan(0)
    // 硬截断必须以省略号收尾（spec §4.5：截断至该级预算并补 …）
    expect(res!.body.endsWith('…')).toBe(true)
  })

  it('阶段 3：40 卷 + recentKeep=3，仅保留最近 3 条卷名并给出「其余 37 卷」注记', () => {
    // 卷名够长 → 阶段 2（全部仅卷名）在 900 B 预算下装不下，必然落到阶段 3
    for (let i = 1; i <= 40; i++) {
      const no = String(i).padStart(2, '0')
      writeVolume(
        crossArchiveDir(root),
        `2026-09-超长卷名占位甲乙丙丁-${no}.md`,
        '摘要占位内容甲乙丙丁戊己庚辛',
        BASE_MTIME + i * 60000,
      )
    }

    const res = buildArchiveIndex({hclawDir: root, workspacePath: null, limits: {maxBytes: 900, recentKeep: 3}})
    expect(res).not.toBeNull()
    expect(res!.truncated).toBe(true)
    expect(Buffer.byteLength(res!.body, 'utf8')).toBeLessThanOrEqual(900)

    // 恰好 3 条卷条目（mtime 倒序取最近 3 卷）
    expect(entryLines(res!.body)).toEqual([
      '- 超长卷名占位甲乙丙丁-40',
      '- 超长卷名占位甲乙丙丁-39',
      '- 超长卷名占位甲乙丙丁-38',
    ])
    // 恰好一行「其余 37 卷」注记
    expect(linesOf(res!.body).filter((line) => line.startsWith('（其余'))).toEqual([
      '（其余 37 卷，可用 bash 列目录查看）',
    ])
  })

  it('跨项目级硬截断不越权：项目段仍完整保留，整体不超预算', () => {
    // 40 卷长卷名 + maxBytes=400：跨项目级即便用 recentKeep=3 也超其半预算（约 200 B），
    // 必须在自身预算内硬截断，而不是吃满总预算后由整体兜底把项目段砍掉。
    for (let i = 1; i <= 40; i++) {
      const no = String(i).padStart(2, '0')
      writeVolume(
        crossArchiveDir(root),
        `2026-09-超长卷名占位甲乙丙丁-${no}.md`,
        '摘要占位内容甲乙丙丁戊己庚辛',
        BASE_MTIME + i * 60000,
      )
    }
    writeVolume(projectArchiveDir(root, 'hclaw'), '2026-09-selection.md', '选区抑制', BASE_MTIME)
    writeIndex(root, {[WS]: {dir: 'hclaw', projectName: 'hclaw'}})

    const res = buildArchiveIndex({hclawDir: root, workspacePath: WS, limits: {maxBytes: 400, recentKeep: 3}})
    expect(res).not.toBeNull()
    expect(res!.truncated).toBe(true)
    expect(Buffer.byteLength(res!.body, 'utf8')).toBeLessThanOrEqual(400)

    // 跨项目级超长 → 在自身预算内硬截断（以 … 收尾）
    expect(res!.body.startsWith('## 跨项目归档卷')).toBe(true)
    expect(res!.body.includes('…')).toBe(true)
    // 项目段仍在：标题、目录行与条目都在（未被整体兜底截断吃掉）
    expect(res!.body).toContain('## 本项目归档卷（hclaw）')
    expect(res!.body).toContain(`目录：${displayDir(projectArchiveDir(root, 'hclaw'))}`)
    expect(entryLines(res!.body)).toContain('- selection：选区抑制')
  })

  it('非法 limits 回落默认值：行为确定，不出现 NaN 预算导致的静默失控', () => {
    writeVolume(crossArchiveDir(root), '2026-09-cross.md', '跨项目总结', BASE_MTIME + DAY)
    const opts = {hclawDir: root, workspacePath: null}
    const natural = buildArchiveIndex({...opts, limits: {maxBytes: 100000, summaryMaxChars: 20, recentKeep: 15}})

    expect(buildArchiveIndex({...opts, limits: {maxBytes: Number.NaN}})).toEqual(natural)
    expect(buildArchiveIndex({...opts, limits: {maxBytes: 0}})).toEqual(natural)
    expect(buildArchiveIndex({...opts, limits: {maxBytes: -1}})).toEqual(natural)
    expect(buildArchiveIndex({...opts, limits: {summaryMaxChars: Number.NaN}})).toEqual(natural)
    expect(buildArchiveIndex({...opts, limits: {recentKeep: -5}})).toEqual(natural)
    expect(buildArchiveIndex({...opts, limits: {maxBytes: Number.POSITIVE_INFINITY}})).toEqual(natural)
  })
})
