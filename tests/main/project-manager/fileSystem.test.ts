// tests/main/project-manager/fileSystem.test.ts
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {execFileSync} from 'child_process'
import {assertInWorkspace, listDirectory, readFileForViewer, readFileText, deletePath, containsNullByte, isImageExt, resetGitRepoCache, deleteGitRepoCache} from '../../../src/main/project-manager/fileSystem'

// fileSystem.ts 现直接 import electron 的 shell（deletePath 走 trashItem）——测试环境无真实 electron，须 mock
const mockTrashItem = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('electron', () => ({shell: {trashItem: mockTrashItem}}))

// 包装 fs/promises.readFile 以便模拟 TOCTOU（readFile 返回比前置 stat 更大的 buffer）
const readFileHook = vi.hoisted(() => ({fn: null as null | ((...args: unknown[]) => unknown)}))
// 注意：本环境中 'fs/promises' 与 'node:fs/promises' 解析为不同实例，须同时 mock
const mockReadFileFn = vi.hoisted(() => vi.fn())
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {...actual, readFile: mockReadFileFn}
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {...actual, readFile: mockReadFileFn}
})
mockReadFileFn.mockImplementation(async (...args: unknown[]) => {
  if (readFileHook.fn) return readFileHook.fn(...args)
  const actual = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).readFile
  return actual(...(args as Parameters<typeof actual>))
})

function makeWs(): string {
  const ws = mkdtempSync(join(tmpdir(), 'pm-fs-'))
  writeFileSync(join(ws, 'a.ts'), 'hello')
  writeFileSync(join(ws, 'img.png'), Buffer.from([0x89, 0x50]))
  writeFileSync(join(ws, 'bin.exe'), Buffer.from([0x00, 0x01]))
  writeFileSync(join(ws, 'big.txt'), 'x'.repeat(11))
  mkdirSync(join(ws, 'node_modules'))
  mkdirSync(join(ws, 'sub'))
  writeFileSync(join(ws, 'sub', 'b.ts'), 'world')
  return ws
}

describe('assertInWorkspace', () => {
  const ws = 'C:\\ws\\proj'
  it('相对路径通过并返回绝对路径', () => {
    expect(assertInWorkspace(ws, 'src/a.ts')).toBe(join(ws, 'src/a.ts'))
  })
  it('../ 逃逸被拒绝', () => {
    expect(() => assertInWorkspace(ws, '../evil')).toThrow('路径超出工作目录')
  })
  it('绝对路径指向外部被拒绝', () => {
    expect(() => assertInWorkspace(ws, 'C:\\other\\x.ts')).toThrow('路径超出工作目录')
  })
  it('workspace 根本身通过', () => {
    expect(assertInWorkspace(ws, '.')).toBe(ws)
  })
})

describe('containsNullByte / isImageExt', () => {
  it('检测 null byte', () => {
    expect(containsNullByte(Buffer.from([0x00, 0x01]))).toBe(true)
    expect(containsNullByte(Buffer.from('abc'))).toBe(false)
  })
  it('图片扩展名', () => {
    expect(isImageExt('a.PNG')).toBe(true)
    expect(isImageExt('a.svg')).toBe(true)
    expect(isImageExt('a.ts')).toBe(false)
  })
})

describe('deletePath', () => {
  beforeEach(() => mockTrashItem.mockReset().mockResolvedValue(undefined))

  it('正常删除：经 assertInWorkspace 后调 shell.trashItem（绝对路径）', async () => {
    const ws = makeWs()
    try {
      await deletePath(ws, 'a.ts')
      expect(mockTrashItem).toHaveBeenCalledWith(join(ws, 'a.ts'))
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('越界路径（../）抛错且不调 trashItem', async () => {
    await expect(deletePath('/ws/a', '../evil')).rejects.toThrow('路径超出工作目录')
    expect(mockTrashItem).not.toHaveBeenCalled()
  })

  it('工作区根（.）抛错且不调 trashItem', async () => {
    await expect(deletePath('/ws/a', '.')).rejects.toThrow('不能删除工作区根目录')
    expect(mockTrashItem).not.toHaveBeenCalled()
  })

  it('空串等价工作区根，同样拒绝', async () => {
    await expect(deletePath('/ws/a', '')).rejects.toThrow('不能删除工作区根目录')
    expect(mockTrashItem).not.toHaveBeenCalled()
  })
})

describe('listDirectory', () => {
  it('跳过黑名单目录、返回 size 与 hasChildren', async () => {
    const ws = makeWs()
    try {
      const entries = await listDirectory(ws, '.', {})
      const names = entries.map(e => e.name)
      expect(names).toContain('a.ts')
      expect(names).toContain('sub')
      expect(names).not.toContain('node_modules')
      const sub = entries.find(e => e.name === 'sub')!
      expect(sub.isDir).toBe(true)
      expect(sub.hasChildren).toBe(true)
      expect(entries.find(e => e.name === 'a.ts')!.gitStatus).toBe('none')
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
  it('gitStatus 从 statusMap 查得', async () => {
    const ws = makeWs()
    try {
      const entries = await listDirectory(ws, '.', {'a.ts': {path: 'a.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'}})
      expect(entries.find(e => e.name === 'a.ts')!.gitStatus).toBe('M')
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
  it('相对路径输入归一化（./sub、sub/../sub），path 与 statusMap 键一致', async () => {
    const ws = makeWs()
    try {
      for (const rel of ['./sub', 'sub/../sub', 'sub']) {
        const entries = await listDirectory(ws, rel, {'sub/b.ts': {path: 'sub/b.ts', status: 'A', indexStatus: 'A', worktreeStatus: ' '}})
        expect(entries).toHaveLength(1)
        expect(entries[0].path).toBe('sub/b.ts')
        expect(entries[0].gitStatus).toBe('A')
      }
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
})

describe('readFileForViewer', () => {
  it('文本文件返回内容与 hash', async () => {
    const ws = makeWs()
    try {
      const r = await readFileForViewer(ws, 'a.ts')
      expect(r.content).toBe('hello')
      expect(r.isBinary).toBe(false)
      expect(r.decodeError).toBe(false)
      expect(r.hash).toHaveLength(16)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
  it('二进制文件 content 为 null', async () => {
    const ws = makeWs()
    try {
      const r = await readFileForViewer(ws, 'bin.exe')
      expect(r.isBinary).toBe(true)
      expect(r.content).toBeNull()
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
  it('图片标记 isImage 与 mimeType', async () => {
    const ws = makeWs()
    try {
      const r = await readFileForViewer(ws, 'img.png')
      expect(r.isImage).toBe(true)
      expect(r.mimeType).toBe('image/png')
      expect(r.base64).toBeTruthy()
      expect(Buffer.from(r.base64!, 'base64')).toEqual(Buffer.from([0x89, 0x50]))
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
  it('超过 5MB 返回 content null', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pm-fs-'))
    writeFileSync(join(ws, 'huge.txt'), Buffer.alloc(5 * 1024 * 1024 + 1))
    try {
      const r = await readFileForViewer(ws, 'huge.txt')
      expect(r.content).toBeNull()
      expect(r.isBinary).toBe(true)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
  it('TOCTOU 复核：stat 小于上限但 readFile 结果超限仍按超限返回', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pm-fs-'))
    // 磁盘上是小文件（stat 报告小 size），但 mock readFile 返回超限 buffer
    writeFileSync(join(ws, 'racy.txt'), 'tiny')
    readFileHook.fn = async () => Buffer.alloc(5 * 1024 * 1024 + 10)
    try {
      const r = await readFileForViewer(ws, 'racy.txt')
      expect(r.content).toBeNull()
      expect(r.isBinary).toBe(true)
      expect(r.size).toBe(5 * 1024 * 1024 + 10)
    } finally {
      readFileHook.fn = null
      rmSync(ws, {recursive: true, force: true})
    }
  })
  it('symlink 指向工作区外的文件被拒绝（fail-closed）', async () => {
    const ws = makeWs()
    const outside = join(tmpdir(), `pm-fs-outside-${process.pid}.txt`)
    writeFileSync(outside, 'secret')
    const link = join(ws, 'leak.txt')
    let linked = false
    try {
      try {
        symlinkSync(outside, link, 'file')
        linked = true
      } catch {
        console.warn('跳过：当前环境无权限创建 symlink')
      }
      if (linked) {
        await expect(readFileForViewer(ws, 'leak.txt')).rejects.toThrow('路径超出工作目录')
        await expect(readFileText(ws, 'leak.txt')).rejects.toThrow('路径超出工作目录')
      }
    } finally {
      if (linked) rmSync(link, {force: true})
      rmSync(ws, {recursive: true, force: true})
      rmSync(outside, {force: true})
    }
  })
  it('不存在的文件按 ENOENT 错误路径处理（fail-closed，不回退词法判断）', async () => {
    const ws = makeWs()
    try {
      await expect(readFileForViewer(ws, 'missing.txt')).rejects.toThrow()
      await expect(readFileText(ws, 'missing.txt')).rejects.toThrow()
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
})

describe('listDirectory：被忽略标记（spec §6.3）', () => {
  beforeEach(() => resetGitRepoCache())

  function makeGitRepo(): string {
    const ws = mkdtempSync(join(tmpdir(), 'pm-git-'))
    execFileSync('git', ['init'], {cwd: ws, stdio: 'ignore'})
    writeFileSync(join(ws, '.gitignore'), 'dist/\n*.log\n')
    writeFileSync(join(ws, 'keep.ts'), 'x')
    writeFileSync(join(ws, 'debug.log'), 'x')
    mkdirSync(join(ws, 'dist'))
    writeFileSync(join(ws, 'dist', 'bundle.js'), 'x')
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'x')
    return ws
  }

  it('.gitignore 命中的条目 ignored === true，未命中的为 false', async () => {
    const ws = makeGitRepo()
    try {
      const entries = await listDirectory(ws, '.', {})
      const ignored = Object.fromEntries(entries.map(e => [e.name, e.ignored]))
      expect(ignored['dist']).toBe(true)         // 目录命中
      expect(ignored['debug.log']).toBe(true)    // 文件命中
      expect(ignored['src']).toBe(false)
      expect(ignored['keep.ts']).toBe(false)
      expect(ignored['.gitignore']).toBe(false)  // 点文件不是被忽略文件
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('回归：退出码 1（无任何命中）不抛错，全部 false', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pm-git-clean-'))
    try {
      execFileSync('git', ['init'], {cwd: ws, stdio: 'ignore'})
      writeFileSync(join(ws, 'a.ts'), 'x')
      const entries = await listDirectory(ws, '.', {})
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.every(e => e.ignored === false)).toBe(true)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('非 git 仓库：全部 false 且不抛错', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pm-nogit-'))
    try {
      writeFileSync(join(ws, 'a.ts'), 'x')
      const entries = await listDirectory(ws, '.', {})
      expect(entries.every(e => e.ignored === false)).toBe(true)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('子目录层同样标记', async () => {
    const ws = makeGitRepo()
    try {
      writeFileSync(join(ws, 'src', 'x.log'), 'x')
      const entries = await listDirectory(ws, 'src', {})
      const ignored = Object.fromEntries(entries.map(e => [e.name, e.ignored]))
      expect(ignored['x.log']).toBe(true)
      expect(ignored['a.ts']).toBe(false)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('deleteGitRepoCache 只失效指定 workspace 的探测缓存（负缓存可回收）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pm-delcache-'))
    try {
      writeFileSync(join(ws, '.gitignore'), 'dist/\n')
      mkdirSync(join(ws, 'dist'))
      // 首轮：非 git 仓库 → 被缓存为 false（负缓存）
      let entries = await listDirectory(ws, '.', {})
      expect(entries.find(e => e.name === 'dist')!.ignored).toBe(false)
      // 此后才变成 git 仓库：负缓存仍在，因此 ignored 依旧为 false
      execFileSync('git', ['init'], {cwd: ws, stdio: 'ignore'})
      entries = await listDirectory(ws, '.', {})
      expect(entries.find(e => e.name === 'dist')!.ignored).toBe(false)
      // 回收该 key 后重新探测，.gitignore 规则生效
      deleteGitRepoCache(ws)
      entries = await listDirectory(ws, '.', {})
      expect(entries.find(e => e.name === 'dist')!.ignored).toBe(true)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
})
