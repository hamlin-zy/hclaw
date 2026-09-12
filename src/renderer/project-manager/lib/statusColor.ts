// Git 状态的展示规格（spec §3.1 三重编码 / §6.2 目录染色）
// 颜色一律走令牌，不留任何 hex 兜底。
import type {DirEntry} from '@shared/types/project-manager'

export type VcsStatus = DirEntry['gitStatus']

export interface StatusSpec {
  /** 状态字母列内容；none 为空串（列仍渲染以保持对齐） */
  letter: string
  /** 文字颜色（CSS 变量） */
  color: string
  fontWeight?: 'bold'
  textDecoration?: 'line-through'
  fontStyle?: 'italic'
  /** 字母列的 aria-label；none 为空串表示不渲染该列 */
  ariaLabel: string
}

/** 颜色 + 字重/样式 + 状态字母——三重冗余，保证色盲用户也能区分（spec §3.1） */
export const STATUS_SPEC: Record<VcsStatus, StatusSpec> = {
  none: {letter: '',   color: 'var(--text-primary)',   ariaLabel: ''},
  M:    {letter: 'M',  color: 'var(--vcs-modified)',   fontWeight: 'bold',           ariaLabel: '已修改'},
  A:    {letter: 'A',  color: 'var(--vcs-added)',                                    ariaLabel: '已新增'},
  D:    {letter: 'D',  color: 'var(--vcs-deleted)',    textDecoration: 'line-through', ariaLabel: '已删除'},
  R:    {letter: 'R',  color: 'var(--vcs-renamed)',                                  ariaLabel: '已重命名'},
  '??': {letter: '??', color: 'var(--vcs-untracked)',  fontStyle: 'italic',          ariaLabel: '未跟踪'},
}

/** 目录染色优先级（spec §6.2）：D > M > R > A > ?? */
const PRIORITY: readonly VcsStatus[] = ['D', 'M', 'R', 'A', '??']

/** 取一组子项状态中优先级最高的一个；全为 none / 空数组时返回 null。 */
export function dominantStatus(statuses: readonly VcsStatus[]): VcsStatus | null {
  for (const candidate of PRIORITY) {
    if (statuses.includes(candidate)) return candidate
  }
  return null
}

/** 状态 → CSS 类名后缀。'??' 不是合法的类名片段，统一映射为 'untracked'。 */
export function statusClassSuffix(status: VcsStatus): string {
  return status === '??' ? 'untracked' : status
}
