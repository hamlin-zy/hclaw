// @vitest-environment jsdom
/**
 * Recent Files 的 MRU 纯逻辑 + localStorage 适配。
 *
 * 保护：同路径去重上移、100 条按 MRU 截断、跨工作区隔离、损坏数据回落空表、
 * 只存相对路径与时间戳（不存文件内容）、虚拟路径不记。
 * 断言只针对外部可观察行为（读回来的列表 / 存储原文），不碰内部实现（spec §Testing Decisions）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {
  RECENT_FILES_LIMIT,
  clearRecentFiles,
  dropRecent,
  mergeRecent,
  normalizeRecent,
  readRecentFiles,
  recentFilesKey,
  recordRecentFile,
  removeRecentFile,
  shouldRecordRecent,
  type RecentFileEntry,
} from '../../../src/renderer/project-manager/lib/recentFiles'

const WS = 'E:/proj/app'
const OTHER_WS = 'E:/proj/lib'

beforeEach(() => localStorage.clear())

describe('mergeRecent（MRU 纯逻辑）', () => {
  it('同路径去重后上移到队头，并刷新时间戳', () => {
    const entries: RecentFileEntry[] = [
      {path: 'a.ts', openedAt: 300},
      {path: 'b.ts', openedAt: 200},
      {path: 'c.ts', openedAt: 100},
    ]
    expect(mergeRecent(entries, 'c.ts', 400)).toEqual([
      {path: 'c.ts', openedAt: 400},
      {path: 'a.ts', openedAt: 300},
      {path: 'b.ts', openedAt: 200},
    ])
  })

  it('超过上限按 MRU 截断，保留最近打开的那些', () => {
    let entries: RecentFileEntry[] = []
    for (let i = 0; i < RECENT_FILES_LIMIT; i++) entries = mergeRecent(entries, `f${i}.ts`, i)
    expect(entries).toHaveLength(RECENT_FILES_LIMIT)
    entries = mergeRecent(entries, 'newest.ts', 9999)
    expect(entries).toHaveLength(RECENT_FILES_LIMIT)
    expect(entries[0].path).toBe('newest.ts')
    // 被挤掉的是最旧的那条（f0），次新的仍在
    expect(entries.some(e => e.path === 'f0.ts')).toBe(false)
    expect(entries[entries.length - 1].path).toBe('f1.ts')
  })

  it('dropRecent 只删指定路径', () => {
    const entries: RecentFileEntry[] = [{path: 'a.ts', openedAt: 2}, {path: 'b.ts', openedAt: 1}]
    expect(dropRecent(entries, 'a.ts')).toEqual([{path: 'b.ts', openedAt: 1}])
  })

  it('虚拟路径（__show__<hash>）不记', () => {
    expect(shouldRecordRecent('__show__abc123')).toBe(false)
    expect(shouldRecordRecent('')).toBe(false)
    expect(shouldRecordRecent('src/a.ts')).toBe(true)
  })
})

describe('normalizeRecent（读盘归一化）', () => {
  it('丢弃非法项、按时间倒序、同路径只留最近一次', () => {
    const raw = [
      {path: 'old.ts', openedAt: 1},
      {path: 'old.ts', openedAt: 9},
      {path: 'bad.ts', openedAt: 'yesterday'},
      {path: '__show__h'},
      null,
      'not-an-entry',
      {path: 'mid.ts', openedAt: 5},
    ]
    expect(normalizeRecent(raw)).toEqual([
      {path: 'old.ts', openedAt: 9},
      {path: 'mid.ts', openedAt: 5},
    ])
  })

  it('非数组一律空表', () => {
    expect(normalizeRecent(null)).toEqual([])
    expect(normalizeRecent({path: 'a.ts', openedAt: 1})).toEqual([])
  })
})

describe('localStorage 适配', () => {
  it('记录后读回，且只存相对路径与时间戳（不存文件内容）', () => {
    recordRecentFile(WS, 'src/a.ts', 1000)
    expect(readRecentFiles(WS)).toEqual([{path: 'src/a.ts', openedAt: 1000}])

    const raw = localStorage.getItem(recentFilesKey(WS))!
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(1)
    expect(Object.keys(parsed[0]).sort()).toEqual(['openedAt', 'path'])
    expect(raw).not.toContain('content')
  })

  it('键按工作区划分：跨工作区互不串味', () => {
    recordRecentFile(WS, 'a.ts', 1)
    recordRecentFile(OTHER_WS, 'b.ts', 2)
    expect(readRecentFiles(WS).map(e => e.path)).toEqual(['a.ts'])
    expect(readRecentFiles(OTHER_WS).map(e => e.path)).toEqual(['b.ts'])
    // 清空一个工作区不影响另一个
    clearRecentFiles(WS)
    expect(readRecentFiles(WS)).toEqual([])
    expect(readRecentFiles(OTHER_WS).map(e => e.path)).toEqual(['b.ts'])
  })

  it('删除单条后列表与存储同步', () => {
    recordRecentFile(WS, 'a.ts', 1)
    recordRecentFile(WS, 'b.ts', 2)
    expect(removeRecentFile(WS, 'a.ts')).toEqual([{path: 'b.ts', openedAt: 2}])
    expect(readRecentFiles(WS)).toEqual([{path: 'b.ts', openedAt: 2}])
  })

  it('损坏数据回落空表且不抛错', () => {
    localStorage.setItem(recentFilesKey(WS), '{ 这不是 JSON')
    expect(() => readRecentFiles(WS)).not.toThrow()
    expect(readRecentFiles(WS)).toEqual([])

    localStorage.setItem(recentFilesKey(WS), '"a string"')
    expect(readRecentFiles(WS)).toEqual([])

    // 损坏后再记录：以空表为基线重新开始，不把坏数据带下去
    recordRecentFile(WS, 'a.ts', 3)
    expect(readRecentFiles(WS)).toEqual([{path: 'a.ts', openedAt: 3}])
  })

  it('存储不可用时静默回落（不抛错、不写脏数据）', () => {
    // 隐私模式 / 配额溢出：Storage 的每个方法都可能抛，逐个打桩覆盖三个入口
    const thrower = () => { throw new Error('QuotaExceededError') }
    const spies = [
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(thrower),
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(thrower),
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(thrower),
    ]
    try {
      expect(() => recordRecentFile(WS, 'a.ts', 1)).not.toThrow()
      expect(readRecentFiles(WS)).toEqual([])
      expect(() => clearRecentFiles(WS)).not.toThrow()
    } finally {
      // 关键：必须恢复，否则后续用例（含其他测试文件）全部受污染
      for (const s of spies) s.mockRestore()
    }
  })

  it('空工作区不读不写（无键可依）', () => {
    expect(readRecentFiles('')).toEqual([])
    expect(recordRecentFile('', 'a.ts', 1)).toEqual([])
  })
})
