import React, {useCallback, useEffect, useMemo, useState} from 'react'
import type {ConversationMeta} from '@shared/types/infra'
import {fuzzyFilter} from '../../lib/search'

/**
 * 「发送到指定会话」的受控选择器（spec §4.3）。
 * 数据源由父级传入（父级负责调 conversationListByWorkspace + pickSessionCandidates）。
 * 键盘：↑/↓ 移动高亮（循环），Enter 选中，输入框即搜索框。
 */
export function SessionPicker({items, value, onChange}: {
  items: ConversationMeta[]
  value: string | null
  onChange: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)

  const display = useMemo(() => {
    const q = search.trim()
    return q ? fuzzyFilter(items, q, ['title', 'preview']) : items
  }, [items, search])

  useEffect(() => { setHighlight(0) }, [search, items])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (display.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(i => (i + 1) % display.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(i => (i - 1 + display.length) % display.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = display[highlight]
      if (item) onChange(item.id)
    }
  }, [display, highlight, onChange])

  return (
    <div className="pm-session-picker" data-testid="pm-session-picker">
      <input
        type="text"
        className="pm-session-picker-input"
        value={search}
        onChange={e => setSearch(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索会话…"
        aria-label="搜索会话"
        data-testid="pm-session-picker-input"
      />
      <div role="listbox" className="pm-session-picker-list" aria-label="会话列表">
        {display.length === 0 ? (
          <div className="pm-session-picker-empty" data-testid="pm-session-picker-empty">暂无可选会话</div>
        ) : display.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={value === c.id}
            className={`pm-session-picker-item${value === c.id ? ' is-selected' : ''}${i === highlight ? ' is-highlight' : ''}`}
            onClick={() => onChange(c.id)}
            data-testid={`pm-session-picker-item-${i}`}
          >
            {c.title}
          </button>
        ))}
      </div>
    </div>
  )
}
