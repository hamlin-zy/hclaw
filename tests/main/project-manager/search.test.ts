// tests/main/project-manager/search.test.ts
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {EventEmitter} from 'events'
import {Transform} from 'stream'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {createHash} from 'crypto'
import type {ChildProcess} from 'child_process'
import {
  __setFileListLimitsForTest,
  __setFindBufferLimitsForTest,
  __setSpawnForTest,
  deleteFileListCache,
  disposeSearchSessions,
  getFindInFilesPage,
  matchPath,
  parseRgMatchEvent,
  rankFileHits,
  readLines,
  resetFileListCache,
  resetSearchSessions,
  searchFiles,
  startFindInFiles,
  stopFindInFiles,
  toPosixPath,
} from '../../../src/main/project-manager/search'

// search.ts → fileSystem.ts 直接 import electron 的 shell，测试环境须 mock（先例：fileSystem.test.ts）
vi.mock('electron', () => ({shell: {trashItem: vi.fn(async () => {})}}))

// ── createReadStream 包装：统计从磁盘真实读出的字节数（验证「按行读不整体载入」）──
// 用 Transform 承接：被销毁时同步销毁底层流，语义与直接 destroy createReadStream 一致
const diskBytesRead = vi.hoisted(() => ({value: 0}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    createReadStream: (...args: unknown[]) => {
      const source = actual.createReadStream(...(args as Parameters<typeof actual.createReadStream>))
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          diskBytesRead.value += chunk.length
          cb(null, chunk)
        },
      })
      counter.on('close', () => source.destroy())
      source.pipe(counter)
      return counter as unknown as ReturnType<typeof actual.createReadStream>
    },
  }
})

// ── stat 钩子：模拟「无权限」「文件过大」等无法在临时目录里稳定复现的分支 ──
const statHook = vi.hoisted(() => ({override: null as null | ((p: string) => unknown)}))
const mockStatFn = vi.hoisted(() => vi.fn())
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {...actual, stat: mockStatFn}
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {...actual, stat: mockStatFn}
})
mockStatFn.mockImplementation(async (...args: unknown[]) => {
  if (statHook.override) return statHook.override(args[0] as string)
  const actual = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).stat
  return actual(...(args as Parameters<typeof actual>))
})

// ── spawn 注入：测试不得真起 rg 进程 ──
interface FakeRgSpec {
  chunks?: string[]
  /** 立即 emit 'error'（模拟 rg 未安装 / spawn 失败） */
  error?: boolean
  code?: number | null
}

function installFakeSpawn(spec: FakeRgSpec | ((args: string[]) => FakeRgSpec)): Array<{cmd: string; args: string[]; cwd: string}> {
  const calls: Array<{cmd: string; args: string[]; cwd: string}> = []
  const fake = ((cmd: string, args: string[], options?: {cwd?: string}) => {
    const s = typeof spec === 'function' ? spec(args) : spec
    calls.push({cmd, args, cwd: options?.cwd ?? ''})
    const child = new EventEmitter() as unknown as ChildProcess & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    const c = child as unknown as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter; kill: () => void}
    c.stdout = new EventEmitter()
    c.stderr = new EventEmitter()
    c.kill = vi.fn(() => {
      setImmediate(() => c.emit('close', null))
    })
    setImmediate(() => {
      if (s.error) {
        c.emit('error', new Error('spawn rg ENOENT'))
        return
      }
      for (const chunk of s.chunks ?? []) c.stdout.emit('data', Buffer.from(chunk, 'utf8'))
      c.emit('close', s.code ?? 0)
    })
    return child
  }) as unknown as typeof import('child_process').spawn
  __setSpawnForTest(fake)
  return calls
}

function rgJsonEvent(path: string, line: number, text: string, submatches?: Array<[number, number]>): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: {text: path},
      lines: {text: `${text}\n`},
      line_number: line,
      submatches: (submatches ?? [[0, 1]]).map(([start, end]) => ({start, end})),
    },
  })
}

function makeWs(files: Record<string, string | Buffer>, dirs: string[] = []): string {
  const ws = mkdtempSync(join(tmpdir(), 'pm-search-'))
  for (const d of dirs) mkdirSync(join(ws, d), {recursive: true})
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(ws, rel)
    mkdirSync(join(abs, '..'), {recursive: true})
    writeFileSync(abs, content)
  }
  cleanups.push(ws)
  return ws
}

const cleanups: string[] = []
afterEach(() => {
  for (const ws of cleanups.splice(0)) rmSync(ws, {recursive: true, force: true})
  __setSpawnForTest(null)
  __setFileListLimitsForTest(null)
  __setFindBufferLimitsForTest(null)
  resetFileListCache()
  resetSearchSessions()
  statHook.override = null
})

beforeEach(() => {
  diskBytesRead.value = 0
})

// ───────────────────────────── 纯函数 ─────────────────────────────

describe('toPosixPath / matchPath', () => {
  it('反斜杠统一为 /', () => {
    expect(toPosixPath('a\\b\\c.ts')).toBe('a/b/c.ts')
    expect(toPosixPath('a/b.ts')).toBe('a/b.ts')
  })

  it('大小写不敏感子串匹配，返回真实区间', () => {
    expect(matchPath('src/App.tsx', 'app')).toEqual({matchStart: 4, matchEnd: 7})
    expect(matchPath('src/App.tsx', 'APP')).toEqual({matchStart: 4, matchEnd: 7})
    expect(matchPath('src/App.tsx', 'zzz')).toBeNull()
  })

  it('空查询返回 null', () => {
    expect(matchPath('a.ts', '')).toBeNull()
  })
})

describe('rankFileHits', () => {
  const hit = (path: string, matchStart: number): {path: string; matchStart: number; matchEnd: number} =>
    ({path, matchStart, matchEnd: matchStart + 1})

  it('路径更浅优先，其次匹配位置更靠前', () => {
    const hits = [
      hit('a/b/c/deep.ts', 0),
      hit('top.ts', 5),
      hit('top-x.ts', 2),
    ]
    const ranked = rankFileHits(hits, 10)
    expect(ranked.map(h => h.path)).toEqual(['top-x.ts', 'top.ts', 'a/b/c/deep.ts'])
  })

  it('末位按 path 升序，保证结果稳定（不依赖扫描顺序）', () => {
    const a = rankFileHits([hit('b.ts', 1), hit('a.ts', 1)], 10).map(h => h.path)
    const b = rankFileHits([hit('a.ts', 1), hit('b.ts', 1)], 10).map(h => h.path)
    expect(a).toEqual(['a.ts', 'b.ts'])
    expect(b).toEqual(['a.ts', 'b.ts'])
  })

  it('按 limit 截断，limit<=0 返回空', () => {
    expect(rankFileHits([hit('a.ts', 0), hit('b.ts', 0), hit('c.ts', 0)], 2)).toHaveLength(2)
    expect(rankFileHits([hit('a.ts', 0)], 0)).toHaveLength(0)
  })
})

describe('parseRgMatchEvent（纯解析函数）', () => {
  it('非 match 事件返回空', () => {
    expect(parseRgMatchEvent({type: 'begin', data: {}}, '/ws')).toEqual([])
    expect(parseRgMatchEvent({type: 'end', data: {}}, '/ws')).toEqual([])
    expect(parseRgMatchEvent(null, '/ws')).toEqual([])
    expect(parseRgMatchEvent('nope', '/ws')).toEqual([])
  })

  it('match 事件：路径相对化（去 ./、统一 /）、行号、行文本去换行', () => {
    const ev = JSON.parse(rgJsonEvent('.\\src\\a.ts', 12, 'const foo = 1', [[6, 9]]))
    expect(parseRgMatchEvent(ev, 'E:\\ws')).toEqual([
      {path: 'src/a.ts', line: 12, text: 'const foo = 1', matchStart: 6, matchEnd: 9},
    ])
  })

  it('同一行的多个 submatch → 只产一条命中项，区间取第一个 submatch', () => {
    // 命中项的单位是**行**（CONTEXT.md）：`needle needle needle` 这种行只应有一条，
    // 否则列表会出现 3 条 path:line 与行文本完全相同的行
    const ev = JSON.parse(rgJsonEvent('a.ts', 1, 'aaa', [[0, 1], [1, 2], [2, 3]]))
    expect(parseRgMatchEvent(ev, '/ws')).toEqual([
      {path: 'a.ts', line: 1, text: 'aaa', matchStart: 0, matchEnd: 1},
    ])
  })

  it('不同行的多个命中各自成条', () => {
    const first = JSON.parse(rgJsonEvent('a.ts', 1, 'needle needle', [[0, 6], [7, 13]]))
    const second = JSON.parse(rgJsonEvent('b.ts', 9, 'needle here', [[0, 6]]))
    expect(parseRgMatchEvent(first, '/ws')).toHaveLength(1)
    expect(parseRgMatchEvent(second, '/ws')).toHaveLength(1)
    expect(parseRgMatchEvent(second, '/ws')[0]).toMatchObject({path: 'b.ts', line: 9, matchStart: 0, matchEnd: 6})
  })

  it('无 submatch 时区间退化为 0,0', () => {
    const ev = {type: 'match', data: {path: {text: './a.ts'}, lines: {text: 'x\n'}, line_number: 2}}
    expect(parseRgMatchEvent(ev, '/ws')).toEqual([
      {path: 'a.ts', line: 2, text: 'x', matchStart: 0, matchEnd: 0},
    ])
  })

  it('byte offset → 字符下标（多字节行）', () => {
    // '中文中文x'：'x' 的字节偏移为 12
    const ev = {type: 'match', data: {path: {text: 'a.ts'}, lines: {text: '中文中文x\n'}, line_number: 1, submatches: [{start: 12, end: 13}]}}
    expect(parseRgMatchEvent(ev, '/ws')[0]).toMatchObject({matchStart: 4, matchEnd: 5, text: '中文中文x'})
  })
})

// ───────────────────────────── File Search ─────────────────────────────

describe('searchFiles', () => {
  it('空查询返回 [] 且不扫描（不起 rg）', async () => {
    const calls = installFakeSpawn({chunks: ['a.ts\n']})
    expect(await searchFiles('/ws', '')).toEqual([])
    expect(await searchFiles('/ws', '   ')).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('rg 清单命中：排序、上限与匹配区间正确', async () => {
    installFakeSpawn({
      chunks: [
        'src/deep/nested/App.tsx\n',
        'App.tsx\n',
        'docs/app-notes.md\n',
        'other.txt\n',
      ],
    })
    const ws = makeWs({})
    const hits = await searchFiles(ws, 'app')
    expect(hits.map(h => h.path)).toEqual(['App.tsx', 'docs/app-notes.md', 'src/deep/nested/App.tsx'])
    for (const h of hits) {
      expect(h.path.slice(h.matchStart, h.matchEnd).toLowerCase()).toBe('app')
    }
  })

  it('匹配区间指向真实命中位置（大小写不敏感）', async () => {
    installFakeSpawn({chunks: ['x/MyFile.ts\n']})
    const ws = makeWs({})
    const [hit] = await searchFiles(ws, 'myfile')
    expect(hit.matchStart).toBe(2)
    expect(hit.matchEnd).toBe(8)
    expect(hit.path.slice(hit.matchStart, hit.matchEnd)).toBe('MyFile')
  })

  it('默认上限 50，可用 limit 收窄', async () => {
    const listing = Array.from({length: 60}, (_, i) => `f${String(i).padStart(3, '0')}.ts`).join('\n')
    const calls = installFakeSpawn({chunks: [listing + '\n']})
    const ws = makeWs({})
    expect(await searchFiles(ws, '.ts')).toHaveLength(50)
    expect(calls).toHaveLength(1)
    deleteFileListCache(ws)
    expect(await searchFiles(ws, '.ts', 3)).toHaveLength(3)
    expect(calls).toHaveLength(2)
  })

  it('rg 参数尊重 .gitignore/隐藏文件（未传 --hidden）并排除依赖目录', async () => {
    const calls = installFakeSpawn({chunks: ['a.ts\n']})
    const ws = makeWs({})
    await searchFiles(ws, 'a')
    const {args} = calls[0]
    expect(args).toContain('--files')
    expect(args).not.toContain('--hidden')
    // 非 git 工作区也要尊重 .gitignore：rg 默认 require_git(true)，不传这面旗 .gitignore 形同虚设
    expect(args).toContain('--no-require-git')
    for (const dir of ['node_modules', '.git', '.vite', '.cache', '.trash']) {
      expect(args.join(' ')).toContain(`!${dir}`)
    }
  })

  it('30 秒 TTL 内复用清单缓存；deleteFileListCache 后重新扫描', async () => {
    const calls = installFakeSpawn({chunks: ['a.ts\nb.ts\n']})
    const ws = makeWs({})
    await searchFiles(ws, 'a')
    await searchFiles(ws, 'b')
    expect(calls).toHaveLength(1)
    deleteFileListCache(ws)
    await searchFiles(ws, 'a')
    expect(calls).toHaveLength(2)
  })

  it('护栏超限降级为不缓存，结果仍然正确', async () => {
    const calls = installFakeSpawn({chunks: ['a1.ts\na2.ts\na3.ts\na4.ts\n']})
    const ws = makeWs({})
    __setFileListLimitsForTest({maxPaths: 2})
    const first = await searchFiles(ws, 'a')
    expect(first.map(h => h.path)).toEqual(['a1.ts', 'a2.ts', 'a3.ts', 'a4.ts'])
    // 未写入缓存 → 第二次仍然重新扫描
    const second = await searchFiles(ws, 'a')
    expect(second.map(h => h.path)).toEqual(first.map(h => h.path))
    expect(calls).toHaveLength(2)
  })

  it('字节护栏超限同样降级为不缓存', async () => {
    const calls = installFakeSpawn({chunks: ['aaaa.ts\nbbbb.ts\n']})
    const ws = makeWs({})
    __setFileListLimitsForTest({maxBytes: 4})
    await searchFiles(ws, 'a')
    await searchFiles(ws, 'b')
    expect(calls).toHaveLength(2)
  })

  it('rg 不可用（spawn error）回退 JS 遍历：排除目录与隐藏文件同样生效', async () => {
    installFakeSpawn({error: true})
    const ws = makeWs(
      {
        'keep.ts': 'x',
        'sub/nested.ts': 'x',
        '.hidden.ts': 'x',
        'node_modules/dep.ts': 'x',
        '.git/config': 'x',
        'dist/bundle.js': 'x',
      },
      ['node_modules', '.git'],
    )
    const hits = await searchFiles(ws, '.ts')
    expect(hits.map(h => h.path).sort()).toEqual(['keep.ts', 'sub/nested.ts'])
  })
})

// ───────────────────────────── readLines ─────────────────────────────

describe('readLines', () => {
  it('按范围返回行文本与总行数', async () => {
    const ws = makeWs({'a.txt': 'l1\nl2\nl3\nl4\n'})
    const r = await readLines(ws, 'a.txt', 2, 3)
    expect(r.lines).toEqual(['l2', 'l3'])
    expect(r.startLine).toBe(2)
    expect(r.endLine).toBe(3)
    expect(r.totalLines).toBe(-1) // 未读到文件尾，未知
    expect(r.error).toBeUndefined()
  })

  it('行号越界夹到合法范围', async () => {
    const ws = makeWs({'a.txt': 'l1\nl2\n'})
    const r = await readLines(ws, 'a.txt', 0, 99)
    expect(r.lines).toEqual(['l1', 'l2'])
    expect(r.startLine).toBe(1)
    expect(r.endLine).toBe(2)
    expect(r.totalLines).toBe(2)
  })

  it('起始行超出文件尾：返回空行 + 精确总行数', async () => {
    const ws = makeWs({'a.txt': 'l1\nl2\n'})
    const r = await readLines(ws, 'a.txt', 50, 60)
    expect(r.lines).toEqual([])
    expect(r.totalLines).toBe(2)
  })

  it('空文件：totalLines=0 且 lines 为空', async () => {
    const ws = makeWs({'empty.txt': ''})
    const r = await readLines(ws, 'empty.txt', 1, 20)
    expect(r.totalLines).toBe(0)
    expect(r.lines).toEqual([])
  })

  it('文件末尾无换行符时最后一行不丢', async () => {
    const ws = makeWs({'a.txt': 'l1\nl2'})
    const r = await readLines(ws, 'a.txt', 1, 10)
    expect(r.lines).toEqual(['l1', 'l2'])
    expect(r.totalLines).toBe(2)
  })

  it('CRLF 行尾不把 \\r 带进行文本', async () => {
    const ws = makeWs({'a.txt': 'l1\r\nl2\r\n'})
    const r = await readLines(ws, 'a.txt', 1, 2)
    expect(r.lines).toEqual(['l1', 'l2'])
  })

  it('二进制（首 chunk 含 NUL）返回 error 且 lines 为空', async () => {
    const ws = makeWs({'bin.dat': Buffer.from([0x61, 0x00, 0x62, 0x0a])})
    const r = await readLines(ws, 'bin.dat', 1, 10)
    expect(r.lines).toEqual([])
    expect(r.error).toBe('二进制文件，无法预览')
  })

  it('路径已消失返回单行原因文案', async () => {
    const ws = makeWs({})
    const r = await readLines(ws, 'missing.txt', 1, 10)
    expect(r.lines).toEqual([])
    expect(r.error).toBe('文件不存在或已被移动')
  })

  it('无权限返回单行原因文案', async () => {
    const ws = makeWs({'a.txt': 'x\n'})
    statHook.override = () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
    const r = await readLines(ws, 'a.txt', 1, 10)
    expect(r.lines).toEqual([])
    expect(r.error).toBe('没有读取该文件的权限')
  })

  it('超过 100MB 阈值返回单行原因文案', async () => {
    const ws = makeWs({'a.txt': 'x\n'})
    statHook.override = () => ({size: 200 * 1024 * 1024, isDirectory: () => false})
    const r = await readLines(ws, 'a.txt', 1, 10)
    expect(r.lines).toEqual([])
    expect(r.error).toContain('文件过大')
  })

  it('路径越出工作目录返回 error 而非抛错', async () => {
    const ws = makeWs({})
    const r = await readLines(ws, '../evil.txt', 1, 10)
    expect(r.lines).toEqual([])
    expect(r.error).toBe('路径超出项目目录')
  })

  it('EOF 短路：范围抵达文件尾且 ≤256KB 时返回全文与 hash（省掉第二次全量读）', async () => {
    const content = 'a\nb\nc'
    const ws = makeWs({'a.txt': content})
    const r = await readLines(ws, 'a.txt', 1, 50)
    expect(r.fullContent).toBe(content)
    expect(r.hash).toBe(createHash('sha256').update(Buffer.from(content)).digest('hex').slice(0, 16))
    expect(r.totalLines).toBe(3)
  })

  it('未抵达文件尾时不返回全文', async () => {
    const ws = makeWs({'a.txt': Array.from({length: 10}, (_, i) => `l${i}`).join('\n') + '\n'})
    const r = await readLines(ws, 'a.txt', 1, 5)
    expect(r.lines).toHaveLength(5)
    expect(r.fullContent).toBeUndefined()
    expect(r.hash).toBeUndefined()
  })

  it('抵达文件尾但超过 256KB 时不返回全文', async () => {
    const big = 'x'.repeat(100 * 1024)
    const content = `${big}\n${big}\n${big}\n`
    const ws = makeWs({'big.txt': content})
    const r = await readLines(ws, 'big.txt', 1, 10)
    expect(r.totalLines).toBe(3)
    expect(r.fullContent).toBeUndefined()
  })

  it('大文件只读请求范围内的字节（不整体载入）', async () => {
    const line = `${'y'.repeat(1023)}\n`
    const ws = makeWs({'huge.txt': line.repeat(4000)}) // ≈4MB
    const r = await readLines(ws, 'huge.txt', 1, 3)
    expect(r.lines).toEqual([line.slice(0, -1), line.slice(0, -1), line.slice(0, -1)])
    expect(r.totalLines).toBe(-1)
    expect(diskBytesRead.value).toBeGreaterThan(0) // 确保 createReadStream 包装确实生效
    expect(diskBytesRead.value).toBeLessThan(1024 * 1024)
  })
})

// ───────────────────────────── Find in Files ─────────────────────────────

describe('Find in Files 会话', () => {
  /** 等待 fake spawn 的 setImmediate 把 data/close 全部派发完 */
  const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

  it('空查询不启动进程，直接返回已结束的空会话', async () => {
    const calls = installFakeSpawn({chunks: []})
    const ws = makeWs({})
    const {sessionId} = startFindInFiles(ws, '   ')
    expect(calls).toHaveLength(0)
    expect(getFindInFilesPage(sessionId, 0, 20)).toEqual({matches: [], truncated: false, done: true})
  })

  it('spawn 参数：--json -F --max-filesize 1M 且排除依赖目录', async () => {
    const calls = installFakeSpawn({chunks: ['']})
    const ws = makeWs({})
    startFindInFiles(ws, 'needle')
    const {args, cwd} = calls[0]
    expect(args).toContain('--json')
    expect(args).toContain('-F')
    // 非 git 工作区也要尊重 .gitignore（同 rgFileListArgs）
    expect(args).toContain('--no-require-git')
    expect(args.join(' ')).toContain('--max-filesize 1M')
    expect(args.join(' ')).toContain('!node_modules')
    expect(args.slice(-2)).toEqual(['needle', '.'])
    expect(cwd).toBe(ws)
  })

  it('分页游标与页边界：按 offset/limit 切片，越界返回空页', async () => {
    installFakeSpawn({
      chunks: [
        `${rgJsonEvent('a.ts', 1, 'hit one')}\n${rgJsonEvent('a.ts', 2, 'hit two')}\n`,
        `${rgJsonEvent('b.ts', 5, 'hit three')}\n${rgJsonEvent('c.ts', 7, 'hit four')}\n`,
        `${rgJsonEvent('d.ts', 9, 'hit five')}\n`,
      ],
    })
    const ws = makeWs({})
    const {sessionId} = startFindInFiles(ws, 'hit')
    await flush()

    const p1 = getFindInFilesPage(sessionId, 0, 2)
    expect(p1.matches.map(m => `${m.path}:${m.line}`)).toEqual(['a.ts:1', 'a.ts:2'])
    expect(p1.done).toBe(true)

    const p2 = getFindInFilesPage(sessionId, 2, 2)
    expect(p2.matches.map(m => `${m.path}:${m.line}`)).toEqual(['b.ts:5', 'c.ts:7'])

    const p3 = getFindInFilesPage(sessionId, 4, 2)
    expect(p3.matches.map(m => `${m.path}:${m.line}`)).toEqual(['d.ts:9'])

    expect(getFindInFilesPage(sessionId, 99, 2).matches).toEqual([])
    expect(getFindInFilesPage('unknown-session', 0, 20)).toEqual({matches: [], truncated: false, done: true})
  })

  it('命中项带行文本与行内区间', async () => {
    installFakeSpawn({chunks: [`${rgJsonEvent('a.ts', 3, 'const needle = 1', [[6, 12]])}\n`]})
    const ws = makeWs({})
    const {sessionId} = startFindInFiles(ws, 'needle')
    await flush()
    const {matches} = getFindInFilesPage(sessionId, 0, 20)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({path: 'a.ts', line: 3, text: 'const needle = 1', matchStart: 6, matchEnd: 12})
    expect(matches[0].text.slice(matches[0].matchStart, matches[0].matchEnd)).toBe('needle')
  })

  it('缓冲达上限即终止进程并标注 truncated', async () => {
    const chunks = Array.from({length: 6}, (_, i) => `${rgJsonEvent(`f${i}.ts`, i + 1, `hit ${i}`)}\n`)
    const calls = installFakeSpawn({chunks})
    const ws = makeWs({})
    __setFindBufferLimitsForTest({maxMatches: 3})
    const {sessionId} = startFindInFiles(ws, 'hit')
    await flush()
    const page = getFindInFilesPage(sessionId, 0, 20)
    expect(page.matches).toHaveLength(3)
    expect(page.truncated).toBe(true)
    expect(page.done).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('字节上限同样触发截断', async () => {
    installFakeSpawn({chunks: Array.from({length: 5}, (_, i) => `${rgJsonEvent(`f${i}.ts`, 1, 'x'.repeat(50))}\n`)})
    const ws = makeWs({})
    __setFindBufferLimitsForTest({maxBytes: 30})
    const {sessionId} = startFindInFiles(ws, 'x')
    await flush()
    const page = getFindInFilesPage(sessionId, 0, 20)
    expect(page.truncated).toBe(true)
    expect(page.matches.length).toBeLessThan(5)
  })

  it('未达上限：done 表示进程结束，truncated 为 false', async () => {
    installFakeSpawn({chunks: [`${rgJsonEvent('a.ts', 1, 'hit')}\n`]})
    const ws = makeWs({})
    const {sessionId} = startFindInFiles(ws, 'hit')
    const before = getFindInFilesPage(sessionId, 0, 20)
    expect(before.done).toBe(false) // 进程尚未结束
    await flush()
    const after = getFindInFilesPage(sessionId, 0, 20)
    expect(after.done).toBe(true)
    expect(after.truncated).toBe(false)
    expect(after.matches).toHaveLength(1)
  })

  it('新查询立即终止并替换旧会话', async () => {
    installFakeSpawn({chunks: [`${rgJsonEvent('a.ts', 1, 'hit')}\n`]})
    const ws = makeWs({})
    const first = startFindInFiles(ws, 'hit')
    await flush()
    const second = startFindInFiles(ws, 'hit')
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(getFindInFilesPage(first.sessionId, 0, 20).matches).toEqual([])
  })

  it('stop 释放缓冲；disposeSearchSessions 回收该 workspace 的会话并 kill 进程', async () => {
    const calls = installFakeSpawn({chunks: [`${rgJsonEvent('a.ts', 1, 'hit')}\n`]})
    const ws = makeWs({})
    const other = makeWs({})
    const s1 = startFindInFiles(ws, 'hit')
    const s2 = startFindInFiles(other, 'hit')
    await flush()

    stopFindInFiles(s1.sessionId)
    expect(getFindInFilesPage(s1.sessionId, 0, 20).matches).toEqual([])

    disposeSearchSessions(ws)
    expect(getFindInFilesPage(s1.sessionId, 0, 20).matches).toEqual([])
    // 其它 workspace 的会话不受影响
    expect(getFindInFilesPage(s2.sessionId, 0, 20).matches).toHaveLength(1)
    expect(calls).toHaveLength(2)
    disposeSearchSessions(other)
  })

  it('rg 不可用（spawn error）时会话标记结束且不崩', async () => {
    installFakeSpawn({error: true})
    const ws = makeWs({})
    const {sessionId} = startFindInFiles(ws, 'hit')
    await flush()
    const page = getFindInFilesPage(sessionId, 0, 20)
    expect(page.matches).toEqual([])
    expect(page.done).toBe(true)
  })

  /**
   * 回归护栏（打包版「搜不到任何东西」事故）：检索进程起不来时**必须**给出原因。
   * 曾经的实现只返回 0 个命中项，UI 上无法与「确实没有匹配」区分，
   * 于是打包产物漏掉 rg.exe 这件事被误读成搜索逻辑的 bug。
   */
  it('rg 不可用（spawn error）时页面带上原因，不伪装成「无匹配」', async () => {
    installFakeSpawn({error: true})
    const ws = makeWs({})
    const {sessionId} = startFindInFiles(ws, 'hit')
    await flush()
    const page = getFindInFilesPage(sessionId, 0, 20)
    expect(page.error).toContain('ripgrep')
  })

  it('rg 异常退出（code 2）且无命中时同样给出原因', async () => {
    installFakeSpawn({code: 2})
    const ws = makeWs({})
    const {sessionId} = startFindInFiles(ws, 'hit')
    await flush()
    expect(getFindInFilesPage(sessionId, 0, 20).error).toBeTruthy()
  })

  it('正常检索（有命中 / 无匹配）不带原因', async () => {
    installFakeSpawn({chunks: [rgJsonEvent('a.ts', 1, 'hit', [[0, 3]]) + '\n'], code: 0})
    const ws = makeWs({})
    const withHit = startFindInFiles(ws, 'hit')
    await flush()
    expect(getFindInFilesPage(withHit.sessionId, 0, 20).error).toBeUndefined()

    installFakeSpawn({chunks: [], code: 1})
    const noHit = startFindInFiles(ws, 'nothing')
    await flush()
    expect(getFindInFilesPage(noHit.sessionId, 0, 20).error).toBeUndefined()
  })
})
