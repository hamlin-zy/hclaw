import {describe, it, expect} from 'vitest'
import {
  quickOpenBindings,
  findQuickOpenConflicts,
  resolveQuickOpenCommand,
} from '../../../src/renderer/project-manager/lib/quickOpenKeymap'

const ev = (p: Partial<{ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string}>) =>
  ({ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', ...p})

describe('quickOpenBindings', () => {
  it('Windows / Linux：Ctrl+Shift+N / Ctrl+E / Ctrl+Shift+F', () => {
    const b = quickOpenBindings(false)
    expect(b.quickOpenFileSearch).toBe('CommandOrControl+Shift+N')
    expect(b.quickOpenRecentFiles).toBe('CommandOrControl+E')
    expect(b.quickOpenFindInFiles).toBe('CommandOrControl+Shift+F')
  })
  it('macOS：Cmd+Shift+O / Cmd+E / Cmd+Shift+F', () => {
    const b = quickOpenBindings(true)
    expect(b.quickOpenFileSearch).toBe('CommandOrControl+Shift+O')
    expect(b.quickOpenRecentFiles).toBe('CommandOrControl+E')
    expect(b.quickOpenFindInFiles).toBe('CommandOrControl+Shift+F')
  })
  it('macOS 不绑 Cmd+Shift+N（Finder 的「新建文件夹」）', () => {
    const b = quickOpenBindings(true)
    expect(Object.values(b)).not.toContain('CommandOrControl+Shift+N')
    expect(resolveQuickOpenCommand(ev({metaKey: true, shiftKey: true, key: 'n'}), b, true, false)).toBe(null)
  })
})

describe('findQuickOpenConflicts', () => {
  it('默认键位表在两平台都无冲突', () => {
    expect(findQuickOpenConflicts(quickOpenBindings(false))).toEqual({})
    expect(findQuickOpenConflicts(quickOpenBindings(true))).toEqual({})
  })
  it('同键多动作被检出，声明序在前者生效', () => {
    const bindings = {...quickOpenBindings(false), quickOpenRecentFiles: 'CommandOrControl+Shift+N'}
    expect(findQuickOpenConflicts(bindings)['CommandOrControl+Shift+N'])
      .toEqual(['quickOpenFileSearch', 'quickOpenRecentFiles'])
    // 声明序在前者生效：同键下仍然打开 File Search
    expect(resolveQuickOpenCommand(ev({ctrlKey: true, shiftKey: true, key: 'N'}), bindings, false, false))
      .toEqual({kind: 'open', mode: 'file-search'})
  })
})

describe('resolveQuickOpenCommand', () => {
  const win = quickOpenBindings(false)
  const mac = quickOpenBindings(true)
  it('三种键位各自映射到对应的 QuickOpen 模式', () => {
    expect(resolveQuickOpenCommand(ev({ctrlKey: true, shiftKey: true, key: 'N'}), win, false, false))
      .toEqual({kind: 'open', mode: 'file-search'})
    expect(resolveQuickOpenCommand(ev({ctrlKey: true, key: 'e'}), win, false, false))
      .toEqual({kind: 'open', mode: 'recent-files'})
    expect(resolveQuickOpenCommand(ev({ctrlKey: true, shiftKey: true, key: 'F'}), win, false, false))
      .toEqual({kind: 'open', mode: 'find-in-files'})
    expect(resolveQuickOpenCommand(ev({metaKey: true, key: 'e'}), mac, true, false))
      .toEqual({kind: 'open', mode: 'recent-files'})
  })
  it('无修饰键 / 未绑定的组合不匹配', () => {
    expect(resolveQuickOpenCommand(ev({key: 'e'}), win, false, false)).toBe(null)
    expect(resolveQuickOpenCommand(ev({ctrlKey: true, key: 'k'}), win, false, false)).toBe(null)
    // macOS 的 File Search 是 Cmd+Shift+O，Windows 键位在 mac 上不生效
    expect(resolveQuickOpenCommand(ev({ctrlKey: true, shiftKey: true, key: 'n'}), mac, true, false)).toBe(null)
    expect(resolveQuickOpenCommand(ev({metaKey: true, shiftKey: true, key: 'o'}), mac, true, false))
      .toEqual({kind: 'open', mode: 'file-search'})
  })
  it('浮层未打开时 Esc 与上下键一律放行', () => {
    expect(resolveQuickOpenCommand(ev({key: 'Escape'}), win, false, false)).toBe(null)
    expect(resolveQuickOpenCommand(ev({key: 'ArrowDown'}), win, false, false)).toBe(null)
    expect(resolveQuickOpenCommand(ev({key: 'ArrowUp'}), win, false, false)).toBe(null)
  })
  it('浮层已打开时 Esc 关闭、上下键归列表', () => {
    expect(resolveQuickOpenCommand(ev({key: 'Escape'}), win, false, true)).toEqual({kind: 'close'})
    expect(resolveQuickOpenCommand(ev({key: 'ArrowDown'}), win, false, true)).toEqual({kind: 'move', delta: 1})
    expect(resolveQuickOpenCommand(ev({key: 'ArrowUp'}), win, false, true)).toEqual({kind: 'move', delta: -1})
  })
  it('浮层已打开时快捷键仍可切换模式', () => {
    expect(resolveQuickOpenCommand(ev({ctrlKey: true, shiftKey: true, key: 'F'}), win, false, true))
      .toEqual({kind: 'open', mode: 'find-in-files'})
  })
})
