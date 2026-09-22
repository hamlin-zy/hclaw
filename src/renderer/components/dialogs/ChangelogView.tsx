/**
 * 变更日志展示小组件 — 更新通知弹窗与关于页共用。
 *
 * 两处外观差异（字号 / 间距 / 标题对齐 / 日期内容）全部通过 props 传入，
 * 组件本身不隐藏任何视觉分支。
 */
import type { CSSProperties } from 'react'
import type { ChangelogEntry } from '../../../shared/types/updater'

interface ChangelogEntryHeaderProps {
  entry: ChangelogEntry
  /** 头部容器类名（两处内边距不同） */
  className: string
  /** 头部容器内联样式（如关于页的底部分隔线） */
  style?: CSSProperties
  /** 标题类名（更新弹窗用 flex-1；关于页用非 flex 版 + 日期 ml-auto 靠右） */
  titleClassName: string
  /** 日期区类名 */
  dateClassName: string
  /** 日期区文本（更新弹窗只显示日期，关于页显示「版本 · 日期」） */
  dateText: string
}

/** 条目头部：tag 徽章 + 标题 + 日期 */
export function ChangelogEntryHeader({
  entry,
  className,
  style,
  titleClassName,
  dateClassName,
  dateText,
}: ChangelogEntryHeaderProps) {
  return (
    <div className={className} style={style}>
      {entry.tag && (
        <span
          className="shrink-0 text-[10px] font-semibold px-[7px] py-[1px] rounded-lg"
          style={{
            background: 'var(--brand-muted)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--brand-border)',
          }}
        >
          {entry.tag}
        </span>
      )}
      <span className={titleClassName} style={{ color: 'var(--text-primary)' }}>
        {entry.title}
      </span>
      <span className={dateClassName} style={{ color: 'var(--text-muted)' }}>
        {dateText}
      </span>
    </div>
  )
}

interface ChangelogItemListProps {
  items: string[]
  /** 单条类名（两处字号 / 行高 / 条目间距不同） */
  className: string
}

/** items 列表：「圆点 + 文本」逐行渲染（不产生额外包裹元素） */
export function ChangelogItemList({ items, className }: ChangelogItemListProps) {
  return (
    <>
      {items.map((line) => (
        <div
          key={line}
          className={`flex gap-2 ${className}`}
          style={{ color: 'var(--text-secondary)' }}
        >
          <span
            className="shrink-0 w-[5px] h-[5px] rounded-full mt-[6px] opacity-[.85]"
            style={{ background: 'var(--brand-primary)' }}
          />
          <span className="min-w-0 break-words">{line}</span>
        </div>
      ))}
    </>
  )
}
