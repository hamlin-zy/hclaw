/**
 * globTool — globToRegex memoize 不破坏结果
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {GLOB_REGEX_CACHE_MAX, globTool, lruSet} from '@/main/agent/tools/builtin/globTool'

describe('globTool — memoize 后结果一致', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-memo-'))
    await fs.mkdir(path.join(tmpRoot, 'src'), {recursive: true})
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), '')
    await fs.writeFile(path.join(tmpRoot, 'a.test.ts'), '')
    await fs.writeFile(path.join(tmpRoot, 'src/b.ts'), '')
    await fs.writeFile(path.join(tmpRoot, 'src/b.js'), '')
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, {recursive: true, force: true})
  })

  function makeContext() {
    return {
      workingDir: tmpRoot,
      abortSignal: new AbortController().signal,
      sendMessage: vi.fn(),
    }
  }

  it('同一 pattern 连续执行两次结果一致（命中缓存）', async () => {
    const r1 = await globTool.execute({pattern: '**/*.ts'}, makeContext() as any)
    const r2 = await globTool.execute({pattern: '**/*.ts'}, makeContext() as any)

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r1.output).toEqual(r2.output)
    expect(r1.output).toContain('a.ts')
    expect(r1.output).toContain(path.join('src', 'b.ts'))
    expect(r1.output).not.toContain('b.js')
  })

  it('不同 pattern（*.test.ts）仍正确匹配', async () => {
    const r = await globTool.execute({pattern: '*.test.ts'}, makeContext() as any)
    expect(r.success).toBe(true)
    expect(r.output).toEqual(['a.test.ts'])
  })
})

describe('globTool — globToRegex 缓存有界（LRU）', () => {
  it('写入超过上限的 pattern 后，最早写入的 key 被淘汰', () => {
    const cache = new Map<string, RegExp>()
    for (let i = 0; i < GLOB_REGEX_CACHE_MAX + 10; i++) {
      lruSet(cache, `key-${i}`, /x/, GLOB_REGEX_CACHE_MAX)
    }
    expect(cache.size).toBe(GLOB_REGEX_CACHE_MAX)
    expect(cache.has('key-0')).toBe(false)
    expect(cache.has('key-9')).toBe(false)
    expect(cache.has('key-10')).toBe(true)
    expect(cache.has(`key-${GLOB_REGEX_CACHE_MAX + 9}`)).toBe(true)
  })

  it('命中后重新插入使其变为最近使用，淘汰的是更早的 key', () => {
    const cache = new Map<string, RegExp>()
    for (let i = 0; i < GLOB_REGEX_CACHE_MAX; i++) {
      lruSet(cache, `key-${i}`, /x/, GLOB_REGEX_CACHE_MAX)
    }
    // 刷新 key-0 到队尾，再写入一个新 key 触发淘汰
    lruSet(cache, 'key-0', /x/, GLOB_REGEX_CACHE_MAX)
    lruSet(cache, 'key-new', /x/, GLOB_REGEX_CACHE_MAX)

    expect(cache.size).toBe(GLOB_REGEX_CACHE_MAX)
    expect(cache.has('key-0')).toBe(true) // 已刷新，存活
    expect(cache.has('key-1')).toBe(false) // 最早未使用，被淘汰
    expect(cache.has('key-new')).toBe(true)
  })
})
