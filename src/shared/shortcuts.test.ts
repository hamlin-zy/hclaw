import { describe, it, expect } from 'vitest'
import {
  SHORTCUT_DEFS, DEFAULT_OVERRIDES, normalizeAccelerator, eventToAccelerator,
  matchEvent, mergeOverrides, findConflicts, platformDefault, resolveDefaults,
} from './shortcuts'

describe('normalizeAccelerator', () => {
  it('归一化大小写与键名', () => {
    expect(normalizeAccelerator('CommandOrControl+Shift+Space')).toBe('CommandOrControl+Shift+Space')
    expect(normalizeAccelerator('ctrl+n')).toBe('CommandOrControl+N')
    expect(normalizeAccelerator('Alt+ArrowUp')).toBe('Alt+Up')
    expect(normalizeAccelerator('CmdOrCtrl+N')).toBe('CommandOrControl+N')
  })
  it('非法输入返回 null', () => {
    expect(normalizeAccelerator('N')).toBe(null)               // 无修饰键
    expect(normalizeAccelerator('Ctrl+Shift')).toBe(null)      // 纯修饰键
    expect(normalizeAccelerator('Ctrl+F13')).toBe(null)        // 非法主键
  })
})

describe('eventToAccelerator', () => {
  const ev = (p: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', ...p }) as KeyboardEvent
  it('mac 上 ctrl 或 meta 都归一为 CommandOrControl', () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, key: 'n' }), true)).toBe('CommandOrControl+N')
    expect(eventToAccelerator(ev({ metaKey: true, key: 'n' }), true)).toBe('CommandOrControl+N')
  })
  it('windows/linux 仅 ctrl 算 CommandOrControl，meta 不算', () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, key: 'n' }), false)).toBe('CommandOrControl+N')
    expect(eventToAccelerator(ev({ metaKey: true, key: 'n' }), false)).toBe(null)
  })
  it('方向键与 shift/alt 组合', () => {
    expect(eventToAccelerator(ev({ altKey: true, key: 'ArrowUp' }), false)).toBe('Alt+Up')
    expect(eventToAccelerator(ev({ ctrlKey: true, shiftKey: true, key: 'N' }), false)).toBe('CommandOrControl+Shift+N')
  })
  it('纯修饰键 / 无修饰键返回 null', () => {
    expect(eventToAccelerator(ev({ key: 'Shift' }), false)).toBe(null)
    expect(eventToAccelerator(ev({ key: 'a' }), false)).toBe(null)
  })
})

describe('matchEvent', () => {
  const ev = (p: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', ...p }) as KeyboardEvent
  it('匹配默认绑定', () => {
    expect(matchEvent(ev({ ctrlKey: true, key: 'n' }), 'CommandOrControl+N', false)).toBe(true)
    expect(matchEvent(ev({ metaKey: true, key: 'n' }), 'CommandOrControl+N', true)).toBe(true)
    expect(matchEvent(ev({ altKey: true, key: 'ArrowUp' }), 'Alt+Up', false)).toBe(true)
  })
  it('修饰键不符不匹配', () => {
    expect(matchEvent(ev({ ctrlKey: true, shiftKey: true, key: 'n' }), 'CommandOrControl+N', false)).toBe(false)
  })
  it('新增输入历史 / 短语选择器绑定', () => {
    expect(matchEvent(ev({ ctrlKey: true, key: 'ArrowUp' }), 'CommandOrControl+Up', false)).toBe(true)
    expect(matchEvent(ev({ metaKey: true, key: 'ArrowDown' }), 'CommandOrControl+Down', true)).toBe(true)
    expect(matchEvent(ev({ ctrlKey: true, shiftKey: true, key: 'V' }), 'CommandOrControl+Shift+V', false)).toBe(true)
    expect(matchEvent(ev({ ctrlKey: true, key: 'ArrowUp' }), 'CommandOrControl+Up', true)).toBe(true)
    expect(matchEvent(ev({ shiftKey: true, key: 'ArrowUp' }), 'CommandOrControl+Up', false)).toBe(false)
  })
})

describe('mergeOverrides', () => {
  it('空覆盖返回默认表', () => {
    expect(mergeOverrides(undefined)).toEqual(Object.fromEntries(SHORTCUT_DEFS.map(d => [d.id, d.default])))
  })
  it('覆盖项生效且废弃 id 被清理', () => {
    const r = mergeOverrides({ newSession: 'CommandOrControl+M', ghostAction: 'Ctrl+X' })
    expect(r.newSession).toBe('CommandOrControl+M')
    expect(Object.keys(r)).not.toContain('ghostAction')
  })
})

describe('findConflicts', () => {
  it('同 accelerator 多 action 返回冲突组', () => {
    const effective = mergeOverrides({ newSession: 'CommandOrControl+B' })
    const c = findConflicts(effective)
    expect(c['CommandOrControl+B']).toEqual(expect.arrayContaining(['toggleLeftSidebar', 'newSession']))
  })
  it('无冲突返回空对象', () => {
    expect(findConflicts(mergeOverrides(undefined))).toEqual({})
  })
  it('可传入自定义定义表（PM 窗口键位层复用同一份检测）', () => {
    const defs = [
      { id: 'a', default: 'CommandOrControl+E' },
      { id: 'b', default: 'CommandOrControl+E' },
      { id: 'c', default: 'CommandOrControl+Shift+F' },
    ]
    expect(findConflicts({ a: 'CommandOrControl+E', b: 'CommandOrControl+E', c: 'CommandOrControl+Shift+F' }, defs))
      .toEqual({ 'CommandOrControl+E': ['a', 'b'] })
  })
})

describe('platformDefault', () => {
  const def = { id: 'x', default: 'CommandOrControl+Shift+N', darwin: 'CommandOrControl+Shift+O' }
  it('非 mac 一律用 default，忽略 darwin 覆盖', () => {
    expect(platformDefault(def, false)).toBe('CommandOrControl+Shift+N')
  })
  it('mac 有 darwin 覆盖则取之', () => {
    expect(platformDefault(def, true)).toBe('CommandOrControl+Shift+O')
  })
  it('无 darwin 覆盖时 mac 落回 default', () => {
    expect(platformDefault({ id: 'x', default: 'CommandOrControl+E' }, true)).toBe('CommandOrControl+E')
  })
  it('darwin 非法（归一化失败）时落回 default', () => {
    expect(platformDefault({ id: 'x', default: 'CommandOrControl+E', darwin: 'N' }, true)).toBe('CommandOrControl+E')
  })
})

describe('resolveDefaults', () => {
  it('按平台对整表求值', () => {
    const defs = [
      { id: 'a', default: 'CommandOrControl+Shift+N', darwin: 'CommandOrControl+Shift+O' },
      { id: 'b', default: 'CommandOrControl+E' },
    ]
    expect(resolveDefaults(defs, false)).toEqual({ a: 'CommandOrControl+Shift+N', b: 'CommandOrControl+E' })
    expect(resolveDefaults(defs, true)).toEqual({ a: 'CommandOrControl+Shift+O', b: 'CommandOrControl+E' })
  })
  it('主窗口定义表不带 darwin：两平台求值一致，且等于既有默认表', () => {
    expect(resolveDefaults(SHORTCUT_DEFS, true)).toEqual(resolveDefaults(SHORTCUT_DEFS, false))
    expect(resolveDefaults(SHORTCUT_DEFS, true)).toEqual(DEFAULT_OVERRIDES)
  })
})
