import {describe, it, expect} from 'vitest'
import {
  PALETTE_TABS,
  TAB_SOURCES,
  nextPaletteTab,
  getPaletteEmptyText,
} from '@/renderer/lib/paletteTabs'

describe('PALETTE_TABS', () => {
  it('包含全部/命令/技能/代理四个 tab，顺序固定', () => {
    expect(PALETTE_TABS.map(t => t.id)).toEqual(['all', 'command', 'skill', 'agent'])
    expect(PALETTE_TABS.map(t => t.label)).toEqual(['全部', '命令', '技能', '代理'])
  })
  it('每个 tab 有随类型变化的 placeholder', () => {
    expect(PALETTE_TABS.find(t => t.id === 'all')!.placeholder).toBe('搜索全部...')
    expect(PALETTE_TABS.find(t => t.id === 'command')!.placeholder).toBe('搜索命令...')
    expect(PALETTE_TABS.find(t => t.id === 'skill')!.placeholder).toBe('搜索技能...')
    expect(PALETTE_TABS.find(t => t.id === 'agent')!.placeholder).toBe('搜索代理...')
  })
})

describe('TAB_SOURCES', () => {
  it('全部不过滤；命令=user+plugin；技能=skill；代理=agent', () => {
    expect(TAB_SOURCES.all).toBeNull()
    expect(TAB_SOURCES.command).toEqual(['user', 'plugin'])
    expect(TAB_SOURCES.skill).toEqual(['skill'])
    expect(TAB_SOURCES.agent).toEqual(['agent'])
  })
})

describe('nextPaletteTab', () => {
  it('正向循环 all→command→skill→agent→all', () => {
    expect(nextPaletteTab('all', 1)).toBe('command')
    expect(nextPaletteTab('command', 1)).toBe('skill')
    expect(nextPaletteTab('skill', 1)).toBe('agent')
    expect(nextPaletteTab('agent', 1)).toBe('all')
  })
  it('反向循环 all→agent→skill→command→all', () => {
    expect(nextPaletteTab('all', -1)).toBe('agent')
    expect(nextPaletteTab('agent', -1)).toBe('skill')
    expect(nextPaletteTab('skill', -1)).toBe('command')
    expect(nextPaletteTab('command', -1)).toBe('all')
  })
})

describe('getPaletteEmptyText', () => {
  it('无查询时显示 暂无可用{名词}', () => {
    expect(getPaletteEmptyText('all', false)).toBe('暂无可用命令')
    expect(getPaletteEmptyText('command', false)).toBe('暂无可用命令')
    expect(getPaletteEmptyText('skill', false)).toBe('暂无可用技能')
    expect(getPaletteEmptyText('agent', false)).toBe('暂无可用代理')
  })
  it('有查询时显示 未找到匹配的{名词}', () => {
    expect(getPaletteEmptyText('all', true)).toBe('未找到匹配的命令')
    expect(getPaletteEmptyText('command', true)).toBe('未找到匹配的命令')
    expect(getPaletteEmptyText('skill', true)).toBe('未找到匹配的技能')
    expect(getPaletteEmptyText('agent', true)).toBe('未找到匹配的代理')
  })
})
