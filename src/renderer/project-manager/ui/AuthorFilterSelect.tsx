import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {GitAuthor} from '@shared/types/project-manager'

/** 弹层面板最大高度，同时用于判断是否向上翻转（与 ThemedCombobox 对齐） */
const PANEL_MAX_H = 240

/**
 * 选中候选后写入过滤串的值。
 * 重名（同名不同 email）时用 email 消歧，否则用作者名；
 * 无名字（git 解析不出 ident 的兜底形态）时退回 email。
 */
export function authorFilterValue(a: GitAuthor, all: GitAuthor[]): string {
  const ambiguous = all.some(o => o !== a && o.name === a.name)
  if (ambiguous && a.email) return a.email
  return a.name || a.email
}

/**
 * 把逗号分隔串里「正在输入的最后一段」整体替换为选中值（追加语义）：
 * `alice, bo` + `Bob` → `alice, Bob, `。
 *
 * 为什么不是「split → 去重 → push」：下拉候选是按**最后一个逗号片段**过滤的，
 * 那段必然是半截输入（如 `bo`）。若保留它，会得到 `bo, Bob`，交给 `--author` 后
 * 变成「取交集」的正则串（`bo` 与 `Bob` 同时成立），过滤为空且用户看不出原因。
 *
 * 规则：
 * - 丢掉最后一段（半截输入），保留前面所有完整片段；
 * - 选中值若已作为完整片段存在，则不重复（仅丢掉半截片段）；
 * - 末尾保留 `", "`，便于继续输入下一位作者。
 */
export function appendAuthorToken(value: string, picked: string): string {
  const segs = value.split(',')
  const head = segs.slice(0, -1).map(s => s.trim()).filter(Boolean)
  const next = head.filter(t => t !== picked)
  next.push(picked)
  return next.join(', ') + ', '
}

/**
 * 空态优先级：加载中 > 有输入但无匹配 > 读取失败 > 仓库确实无作者。
 * 「读取失败」与「暂无作者」必须可区分，否则 git 未安装 / 权限 / 超时会被误导为「仓库没作者」。
 */
function emptyStateText(loading: boolean, hasToken: boolean, error: boolean): string {
  if (loading) return '正在加载作者…'
  if (hasToken) return '无匹配作者'
  if (error) return '作者列表读取失败，可直接手动输入'
  return '仓库暂无作者'
}

export interface AuthorFilterSelectProps {
  /** 逗号分隔的原始作者过滤串（自由手输 + 下拉追加共用同一个值） */
  value: string
  onChange: (value: string) => void
  authors: GitAuthor[]
  loading?: boolean
  /**
   * 作者列表读取失败（git 未安装 / 超时 / 权限 / 非仓库等）。
   * 与「仓库确实没有作者」区分开，避免误导排查方向。
   */
  error?: boolean
  placeholder?: string
  ariaLabel?: string
}

/**
 * PM 过滤栏用的轻量「作者选择器」：自由输入框 + 候选下拉（多选=追加为逗号分隔值）。
 *
 * 为什么不直接用 ThemedCombobox / ThemedSelect：
 * - ThemedSelect 是单选，选中即整体替换，无法承载 `filterUser: string[]` 的逗号列表语义；
 * - ThemedCombobox 的 suggestions 是纯 string[]，装不下 GitAuthor 的 name/email/commits，
 *   也无从「同名不同 email 时显示 email 消歧」；且它的 pick 同样是整体替换。
 * 因此新建本组件：复用既有 `.pm-commits-input` 尺寸与 ThemedCombobox 的 portal 定位范式，
 * 不引入任何新依赖。
 */
export function AuthorFilterSelect({
  value,
  onChange,
  authors,
  loading = false,
  error = false,
  placeholder = '',
  ariaLabel,
}: AuthorFilterSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [pos, setPos] = useState<{top: number; left: number; width: number; dropUp: boolean} | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 只用最后一个逗号片段做过滤：用户已确认的前缀不参与建议匹配
  const lastToken = (value.split(',').pop() ?? '').trim().toLowerCase()
  const filtered = lastToken
    ? authors.filter(a =>
        a.name.toLowerCase().includes(lastToken) || a.email.toLowerCase().includes(lastToken))
    : authors

  useLayoutEffect(() => {
    if (!open || !inputRef.current) return
    const rect = inputRef.current.getBoundingClientRect()
    const dropUp = window.innerHeight - rect.bottom < PANEL_MAX_H && rect.top > PANEL_MAX_H
    setPos({top: dropUp ? rect.top - 6 : rect.bottom + 6, left: rect.left, width: rect.width, dropUp})
  }, [open])

  // 靠窗口右缘时向左收拢，避免面板溢出视口
  useLayoutEffect(() => {
    if (!open || !pos || !panelRef.current) return
    const pw = panelRef.current.offsetWidth
    const maxLeft = window.innerWidth - pw - 8
    if (pos.left > maxLeft) setPos(p => (p ? {...p, left: Math.max(8, maxLeft)} : p))
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const handleOutside = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const pick = (a: GitAuthor) => {
    const picked = authorFilterValue(a, authors)
    onChange(appendAuthorToken(value, picked))
    setActiveIdx(-1)
    // 保持展开与焦点：支持连续追加多个作者
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (open) {
        setOpen(false)
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) {
        setOpen(true)
        setActiveIdx(e.key === 'ArrowDown' ? 0 : Math.max(filtered.length - 1, 0))
        e.preventDefault()
        return
      }
      const n = filtered.length
      if (n === 0) return
      setActiveIdx(i => {
        const base = i < 0 ? (e.key === 'ArrowDown' ? -1 : n) : i
        return (base + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
      })
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && open && activeIdx >= 0 && activeIdx < filtered.length) {
      pick(filtered[activeIdx]!)
      e.preventDefault()
    }
  }

  // 空态文案取值见 emptyStateText；lastToken 为空串表示用户尚未输入片段
  return (
    <>
      <input
        ref={inputRef}
        type="text"
        className="pm-commits-input"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={e => {
          onChange(e.target.value)
          if (!open) setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        data-testid="pm-author-filter-input"
      />

      {open && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          aria-label="作者候选"
          style={{
            position: 'fixed',
            top: pos?.dropUp ? undefined : pos?.top,
            bottom: pos?.dropUp ? window.innerHeight - (pos?.top ?? 0) : undefined,
            left: pos?.left,
            minWidth: pos?.width,
            maxWidth: 'min(320px, calc(100vw - 16px))',
          }}
          className="z-[100002]"
        >
          <div className="bg-[var(--surface-elevated)] border border-[var(--border)] rounded-xl shadow-2xl shadow-black/20 overflow-hidden max-h-[240px] overflow-y-auto">
            <div className="p-1.5 flex flex-col">
              {filtered.map((a, i) => (
                <button
                  key={`${a.name}\u0000${a.email}`}
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(a)}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`w-full px-2.5 py-2 text-left text-[11px] rounded-lg transition-colors ${
                    i === activeIdx
                      ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)] font-medium'
                      : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                  }`}
                  data-testid={`pm-author-option-${i}`}
                >
                  <span className="block truncate">{a.name || a.email}</span>
                  <span className="block truncate text-[10px] text-[var(--text-muted)] mt-0.5">
                    {a.email}{a.email && a.commits > 0 ? ' · ' : ''}{a.commits > 0 ? `${a.commits} 次提交` : ''}
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-2.5 py-3 text-center text-[11px] text-[var(--text-muted)]">
                  {emptyStateText(loading, lastToken !== '', error)}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
