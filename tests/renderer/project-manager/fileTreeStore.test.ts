// @vitest-environment jsdom
import {describe, it, expect, beforeEach} from 'vitest'
import {useFileTreeStore, CACHE_LIMIT} from '../../../src/renderer/project-manager/stores/fileTreeStore'
import type {DirEntry} from '@shared/types/project-manager'

function entry(path: string, isDir = true): DirEntry {
  return {name: path.split('/').pop()!, path, isDir, size: 0, gitStatus: 'none', hasChildren: isDir, ignored: false}
}

function fillCache(n: number) {
  for (let i = 0; i < n; i++) useFileTreeStore.getState().setChildren(`d${String(i).padStart(4, '0')}`, [entry(`d${i}/f.ts`, false)])
}

beforeEach(() => useFileTreeStore.setState({expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null}))

describe('fileTreeStore', () => {
  it('LRU 淘汰边界：499 不淘汰、500 恰满、501 淘汰最旧一条', () => {
    fillCache(499)
    expect(useFileTreeStore.getState().cacheOrder.length).toBe(499)
    useFileTreeStore.getState().setChildren('d0499', [entry('d0499/f.ts', false)])
    expect(useFileTreeStore.getState().cacheOrder.length).toBe(500)
    // 访问最旧的 d0000，使其变最新，再插入一条应淘汰 d0001 而非 d0000
    expect(useFileTreeStore.getState().getChildren('d0000')).toBeDefined()
    useFileTreeStore.getState().setChildren('new', [])
    const s = useFileTreeStore.getState()
    expect(s.cacheOrder.length).toBe(500)
    expect(s.childrenCache['d0000']).toBeDefined()
    expect(s.childrenCache['d0001']).toBeUndefined()
    expect(s.childrenCache['new']).toEqual([])
    expect(CACHE_LIMIT).toBe(500)
  })
  it('dropSubtree 前缀子树被删，兄弟前缀 a vs ab 不误杀', () => {
    useFileTreeStore.getState().setChildren('a', [entry('a/x.ts')])
    useFileTreeStore.getState().setChildren('ab', [entry('ab/y.ts')])
    useFileTreeStore.getState().setChildren('ab/sub', [entry('ab/sub/z.ts')])
    useFileTreeStore.getState().setChildren('b', [entry('b/w.ts')])
    useFileTreeStore.getState().dropSubtree('a')
    const s = useFileTreeStore.getState()
    expect(s.childrenCache['a']).toBeUndefined()
    expect(s.childrenCache['ab']).toBeDefined()
    expect(s.childrenCache['ab/sub']).toBeDefined()
    expect(s.childrenCache['b']).toBeDefined()
    expect(s.cacheOrder).toEqual(['ab', 'ab/sub', 'b'])
  })
  it('dropSubtree 保留无关目录，可重复调用（不再有 tick 语义）', () => {
    useFileTreeStore.getState().setChildren('a', [entry('a/x.ts')])
    useFileTreeStore.getState().setChildren('keep', [entry('keep/y.ts')])
    useFileTreeStore.getState().dropSubtree('a')
    const s = useFileTreeStore.getState()
    expect(s.childrenCache['a']).toBeUndefined()
    expect(s.childrenCache['keep']).toBeDefined()
    useFileTreeStore.getState().dropSubtree('a')
    expect(useFileTreeStore.getState().childrenCache['keep']).toBeDefined()
  })
  it('dropSubtree(".") 短路：根键是整棵树的渲染前提，绝不能被删', () => {
    useFileTreeStore.getState().setChildren('.', [entry('src')])
    useFileTreeStore.getState().setChildren('src', [entry('src/x.ts')])
    useFileTreeStore.getState().dropSubtree('.')
    const s = useFileTreeStore.getState()
    expect(s.childrenCache['.']).toBeDefined()
    expect(s.childrenCache['src']).toBeDefined()
  })
  it('setChildren 原地替换只换目标目录：其它目录缓存对象引用不变', () => {
    useFileTreeStore.getState().setChildren('a', [entry('a/x.ts')])
    useFileTreeStore.getState().setChildren('b', [entry('b/y.ts')])
    const beforeA = useFileTreeStore.getState().childrenCache['a']
    const beforeB = useFileTreeStore.getState().childrenCache['b']
    useFileTreeStore.getState().setChildren('a', [entry('a/z.ts')])
    const s = useFileTreeStore.getState()
    expect(s.childrenCache['a']).not.toBe(beforeA)   // 目标目录换成新数组
    expect(s.childrenCache['b']).toBe(beforeB)       // 兄弟目录引用不动
  })
  it('getChildren 命中时刷新 LRU 访问序', () => {
    useFileTreeStore.getState().setChildren('x', [entry('x/f.ts', false)])
    useFileTreeStore.getState().setChildren('y', [entry('y/f.ts', false)])
    expect(useFileTreeStore.getState().cacheOrder).toEqual(['x', 'y'])
    expect(useFileTreeStore.getState().getChildren('x')).toEqual([entry('x/f.ts', false)])
    expect(useFileTreeStore.getState().cacheOrder).toEqual(['y', 'x'])
    // 未命中不改动访问序
    expect(useFileTreeStore.getState().getChildren('missing')).toBeUndefined()
    expect(useFileTreeStore.getState().cacheOrder).toEqual(['y', 'x'])
  })
  it('setChildren 重复写同路径不产生重复 order 项', () => {
    useFileTreeStore.getState().setChildren('p', [])
    useFileTreeStore.getState().setChildren('p', [])
    const s = useFileTreeStore.getState()
    expect(s.cacheOrder).toEqual(['p'])
    expect(Object.keys(s.childrenCache)).toEqual(['p'])
  })

  describe('LRU 固定保留根键 "."（CACHE_LIMIT 语义 = 除根外的目录上限）', () => {
    it('写入 >CACHE_LIMIT 个目录后 "." 仍在缓存，且键数不超过 CACHE_LIMIT', () => {
      useFileTreeStore.getState().setChildren('.', [entry('a.ts', false)])
      fillCache(CACHE_LIMIT + 5)   // 远超上限，必然触发多轮淘汰

      const s = useFileTreeStore.getState()
      expect(s.childrenCache['.']).toBeDefined()
      expect(Object.keys(s.childrenCache).length).toBeLessThanOrEqual(CACHE_LIMIT)
      expect(s.cacheOrder.length).toBeLessThanOrEqual(CACHE_LIMIT)
      expect(s.cacheOrder).toContain('.')
      // 淘汰按 LRU：最旧的若干条被驱逐，最新的仍在
      expect(s.childrenCache['d0000']).toBeUndefined()
      expect(s.childrenCache[`d${String(CACHE_LIMIT + 4).padStart(4, '0')}`]).toBeDefined()
    })

    it('驱逐的确实是最久未用者（根键除外）：越界 1 条只驱逐队首非根项', () => {
      useFileTreeStore.getState().setChildren('.', [])
      fillCache(CACHE_LIMIT)   // '.' + 500 个目录 = 501 → 越界 1

      const s = useFileTreeStore.getState()
      expect(s.cacheOrder.length).toBe(CACHE_LIMIT)
      expect(s.cacheOrder[0]).toBe('.')                 // 根未被驱逐，仍在序首（最旧位）
      expect(s.childrenCache['.']).toBeDefined()
      expect(s.childrenCache['d0000']).toBeUndefined()  // 队首非根项才是被驱逐者
      expect(s.childrenCache['d0001']).toBeDefined()
    })

    it('根键被 getChildren 访问移到队尾后，仍不会被驱逐', () => {
      useFileTreeStore.getState().setChildren('.', [])
      fillCache(CACHE_LIMIT)          // 501 → 驱逐 d0000
      expect(useFileTreeStore.getState().getChildren('.')).toEqual([])   // '.' 移到队尾（最新）
      const order = useFileTreeStore.getState().cacheOrder
      expect(order[order.length - 1]).toBe('.')
      useFileTreeStore.getState().setChildren('extra', [])
      const s = useFileTreeStore.getState()
      expect(s.childrenCache['.']).toBeDefined()
      expect(s.cacheOrder.length).toBe(CACHE_LIMIT)
      expect(s.childrenCache['extra']).toBeDefined()
    })

    it('setChildrenBulk 同样固定保留根键 "."', () => {
      useFileTreeStore.getState().setChildren('.', [])
      const bulk: Record<string, DirEntry[]> = {}
      for (let i = 0; i < CACHE_LIMIT + 5; i++) bulk[`b${String(i).padStart(4, '0')}`] = []
      useFileTreeStore.getState().setChildrenBulk(bulk)

      const s = useFileTreeStore.getState()
      expect(s.childrenCache['.']).toBeDefined()
      expect(Object.keys(s.childrenCache).length).toBeLessThanOrEqual(CACHE_LIMIT)
      expect(s.childrenCache['b0000']).toBeUndefined()   // 最久未用者被驱逐
    })

    it('"." 不在 order 中（未加载）时淘汰行为不受影响，且不会凭空造出根键', () => {
      fillCache(CACHE_LIMIT + 1)   // 无根键：越界 1 条 → 正常驱逐最旧者
      const s = useFileTreeStore.getState()
      expect(s.childrenCache['.']).toBeUndefined()
      expect(s.cacheOrder.length).toBe(CACHE_LIMIT)
      expect(s.childrenCache['d0000']).toBeUndefined()
    })
  })

  describe('setChildrenBulk（全展单次提交）', () => {
    it('一次写入多条：合并进缓存且 order 去重后统一置尾', () => {
      useFileTreeStore.getState().setChildren('old', [])
      useFileTreeStore.getState().setChildrenBulk({'a': [entry('a/x.ts')], 'b': [entry('b/y.ts')], 'old': [entry('old/z.ts')]})
      const s = useFileTreeStore.getState()
      expect(s.cacheOrder).toEqual(['a', 'b', 'old'])
      expect(s.childrenCache['a']).toEqual([entry('a/x.ts')])
      expect(s.childrenCache['old']).toEqual([entry('old/z.ts')])
    })

    it('空对象不产生新引用（避免无谓全树重渲）', () => {
      useFileTreeStore.getState().setChildren('a', [])
      const before = useFileTreeStore.getState().childrenCache
      useFileTreeStore.getState().setChildrenBulk({})
      expect(useFileTreeStore.getState().childrenCache).toBe(before)
    })

    it('归属校验：ownerWs 与当前 ws 不符时整批丢弃', () => {
      useFileTreeStore.getState().setWorkspace('/A')
      useFileTreeStore.getState().setChildrenBulk({'a': [entry('a/x.ts')]}, '/B')
      expect(useFileTreeStore.getState().childrenCache['a']).toBeUndefined()
    })

    it('仍受 CACHE_LIMIT 约束：整批写入后淘汰最旧', () => {
      fillCache(CACHE_LIMIT)
      useFileTreeStore.getState().setChildrenBulk({'extra1': [], 'extra2': []})
      const s = useFileTreeStore.getState()
      expect(s.cacheOrder.length).toBe(CACHE_LIMIT)
      expect(s.childrenCache['extra1']).toBeDefined()
      expect(s.childrenCache['d0000']).toBeUndefined()
      expect(s.childrenCache['d0001']).toBeUndefined()
    })

    it('路径恰为 __proto__ 时写成自有属性，不污染原型', () => {
      useFileTreeStore.getState().setChildrenBulk({['__proto__']: [entry('__proto__/f.ts', false)]})
      const s = useFileTreeStore.getState()
      expect(Object.prototype.hasOwnProperty.call(s.childrenCache, '__proto__')).toBe(true)
      expect(s.cacheOrder).toEqual(['__proto__'])
      expect(Object.getPrototypeOf(s.childrenCache)).toBe(Object.prototype)   // 原型未被污染
    })
  })
})

describe('reveal 目标态（spec §3.1）', () => {
  beforeEach(() => { useFileTreeStore.setState({revealTarget: null, ws: null, expanded: new Set(), childrenCache: {}, cacheOrder: []}) })

  it('初始为 null，requestReveal 写入 / clearReveal 清空', () => {
    expect(useFileTreeStore.getState().revealTarget).toBeNull()
    useFileTreeStore.getState().requestReveal('src/a.ts')
    expect(useFileTreeStore.getState().revealTarget).toBe('src/a.ts')
    useFileTreeStore.getState().clearReveal()
    expect(useFileTreeStore.getState().revealTarget).toBeNull()
  })

  it('切换 workspace 时清空 revealTarget（不留残留目标给下次挂载误触发）', () => {
    useFileTreeStore.getState().setWorkspace('/ws1')
    useFileTreeStore.getState().requestReveal('a.ts')
    useFileTreeStore.getState().setWorkspace('/ws2')
    expect(useFileTreeStore.getState().revealTarget).toBeNull()
  })
})

describe('fileTreeStore 多选（spec §4.2）', () => {
  beforeEach(() => useFileTreeStore.setState({selectedPath: null, selectedPaths: new Set(), anchorPath: null}))

  it('普通点击替换为单项，主选 = 该项', () => {
    useFileTreeStore.getState().selectWithMods('a', ['a', 'b', 'c'], {})
    expect([...useFileTreeStore.getState().selectedPaths]).toEqual(['a'])
    expect(useFileTreeStore.getState().selectedPath).toBe('a')
    expect(useFileTreeStore.getState().anchorPath).toBe('a')
  })

  it('Ctrl 点击加选并成为主选', () => {
    useFileTreeStore.getState().selectWithMods('a', ['a', 'b', 'c'], {})
    useFileTreeStore.getState().selectWithMods('c', ['a', 'b', 'c'], {ctrl: true})
    expect([...useFileTreeStore.getState().selectedPaths].sort()).toEqual(['a', 'c'])
    expect(useFileTreeStore.getState().selectedPath).toBe('c')
  })

  it('Shift 区间选，anchor 保持为起点', () => {
    useFileTreeStore.getState().selectWithMods('a', ['a', 'b', 'c'], {})
    useFileTreeStore.getState().selectWithMods('c', ['a', 'b', 'c'], {shift: true})
    expect([...useFileTreeStore.getState().selectedPaths].sort()).toEqual(['a', 'b', 'c'])
    expect(useFileTreeStore.getState().anchorPath).toBe('a')
    expect(useFileTreeStore.getState().selectedPath).toBe('c')
  })

  it('select(null) 清空多选', () => {
    useFileTreeStore.getState().selectWithMods('a', ['a', 'b'], {})
    useFileTreeStore.getState().select(null)
    expect(useFileTreeStore.getState().selectedPaths.size).toBe(0)
    expect(useFileTreeStore.getState().selectedPath).toBeNull()
    expect(useFileTreeStore.getState().anchorPath).toBeNull()
  })

  it('select(path) 同时收敛为单项多选', () => {
    useFileTreeStore.getState().selectWithMods('a', ['a', 'b', 'c'], {})
    useFileTreeStore.getState().selectWithMods('b', ['a', 'b', 'c'], {ctrl: true})
    useFileTreeStore.getState().select('c')
    expect([...useFileTreeStore.getState().selectedPaths]).toEqual(['c'])
    expect(useFileTreeStore.getState().selectedPath).toBe('c')
  })
})
