/**
 * CommandPalette 顶部 tab 模型 — 纯逻辑，无 DOM 依赖（可在 vitest node 环境单测）
 */

export type PaletteSource = 'user' | 'plugin' | 'skill' | 'agent'
export type PaletteTab = 'all' | 'command' | 'skill' | 'agent'

export const PALETTE_TABS: { id: PaletteTab; label: string; placeholder: string }[] = [
  { id: 'all', label: '全部', placeholder: '搜索全部...' },
  { id: 'command', label: '命令', placeholder: '搜索命令...' },
  { id: 'skill', label: '技能', placeholder: '搜索技能...' },
  { id: 'agent', label: '代理', placeholder: '搜索代理...' },
]

// tab → 允许的 source 集合；null 表示不过滤（全部）
export const TAB_SOURCES: Record<PaletteTab, PaletteSource[] | null> = {
  all: null,
  command: ['user', 'plugin'],
  skill: ['skill'],
  agent: ['agent'],
}

// 循环切换：dir=1 下一个（Alt+→），dir=-1 上一个（Alt+←）
export function nextPaletteTab(current: PaletteTab, dir: 1 | -1): PaletteTab {
  const order = PALETTE_TABS.map(t => t.id)
  const idx = order.indexOf(current)
  const next = (idx + dir + order.length) % order.length
  return order[next]
}

// 空状态文案：无查询 → 暂无可用{名词}；有查询 → 未找到匹配的{名词}
const TAB_NOUN: Record<PaletteTab, string> = {
  all: '命令',
  command: '命令',
  skill: '技能',
  agent: '代理',
}

export function getPaletteEmptyText(tab: PaletteTab, hasQuery: boolean): string {
  const noun = TAB_NOUN[tab]
  return hasQuery ? `未找到匹配的${noun}` : `暂无可用${noun}`
}
