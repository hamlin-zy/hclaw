export interface MultiSelectState {
  selected: Set<string>
  anchor: string | null
}

/** 从鼠标事件提取多选修饰键（Ctrl/Cmd 等价，Shift 区间选） */
export function modsOf(e: {ctrlKey: boolean; metaKey: boolean; shiftKey: boolean}): {ctrl: boolean; shift: boolean} {
  return {ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey}
}

export interface MultiSelectResult {
  selected: Set<string>
  anchor: string | null
  /** 主选（= 最近一次单击项；Ctrl 取消后回退 anchor，再回退集合首项，空则 null） */
  main: string | null
}

/**
 * 列表多选语义（与 DiffViewer.startSelect 对齐）：
 * - 普通单击：替换为 {key}
 * - Ctrl/Cmd：切换 key
 * - Shift：anchor 到 key 的闭区间；无有效 anchor 时回退为普通替换
 */
export function applyMultiSelect(
  current: MultiSelectState,
  key: string,
  order: string[],
  mods: {ctrl?: boolean; shift?: boolean},
): MultiSelectResult {
  if (mods.shift) {
    const anchorIndex = current.anchor === null ? -1 : order.indexOf(current.anchor)
    const keyIndex = order.indexOf(key)
    if (anchorIndex >= 0 && keyIndex >= 0) {
      const [from, to] = anchorIndex <= keyIndex ? [anchorIndex, keyIndex] : [keyIndex, anchorIndex]
      return {selected: new Set(order.slice(from, to + 1)), anchor: current.anchor, main: key}
    }
    // 回退：普通替换
  }

  if (mods.ctrl) {
    const next = new Set(current.selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    const main = next.has(key)
      ? key
      : (current.anchor && next.has(current.anchor) ? current.anchor : (next.values().next().value ?? null))
    return {selected: next, anchor: key, main}
  }

  return {selected: new Set([key]), anchor: key, main: key}
}
