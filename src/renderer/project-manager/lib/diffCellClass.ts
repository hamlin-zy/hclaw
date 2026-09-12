/**
 * diff 行的「修饰类」派生：把原先散在 DiffViewer 三处的嵌套三元收敛成两个纯函数。
 *
 * 修饰类是**字符串拼接**进 class 的（`pm-diff-gutter${cls}` / `pm-diff-code${cls}` / `pm-diff-inline-row${cls}`），
 * 所以前导空格是字面量的一部分，绝不能被 trim 掉；中性态是空串而非 undefined。
 *
 * side-by-side 的左右**不对称**（这是最容易改错的地方）：
 * - 左（旧/删）侧：本侧无内容 → 空槽；本行是 del/change → 删除色
 * - 右（新/增）侧：本侧无内容 → 空槽；本行是 add/change → 新增色
 * 空槽判定**优先于**颜色判定，故 add 行的左格是 is-blank 而不是空串。
 * inline 是单列，删/增各占一行，不存在「一侧为空」的情况 —— 故没有 is-blank。
 */

/** side-by-side 的行 kind（与 DiffViewer 内部 DiffRow.kind 同口径） */
export type DiffRowKind = 'context' | 'change' | 'del' | 'add'

/** 无内容的对侧空槽 */
export const CELL_BLANK = ' is-blank'
/** 本侧为删除内容（左列 / inline 删行） */
export const CELL_REMOVED = ' is-removed'
/** 本侧为新增内容（右列 / inline 增行） */
export const CELL_ADDED = ' is-added'

/** 纯函数只依赖这三个字段；DiffRow 结构兼容（多余字段无碍） */
export type DiffRowLike = {kind: DiffRowKind, left?: string, right?: string}

export type SbsSide = 'left' | 'right'

/** side-by-side 单侧单元格的修饰类。空槽优先，再判本侧增删色。 */
export function sbsCellClass(row: DiffRowLike, side: SbsSide): string {
  const cell = side === 'left' ? row.left : row.right
  if (cell === undefined) return CELL_BLANK
  if (side === 'left') return row.kind === 'del' || row.kind === 'change' ? CELL_REMOVED : ''
  return row.kind === 'add' || row.kind === 'change' ? CELL_ADDED : ''
}

/** inline（单列）行的修饰类。kind 已是逐行的 del/add/context，无 is-blank。 */
export function inlineCellClass(kind: 'context' | 'del' | 'add'): string {
  if (kind === 'add') return CELL_ADDED
  if (kind === 'del') return CELL_REMOVED
  return ''
}
