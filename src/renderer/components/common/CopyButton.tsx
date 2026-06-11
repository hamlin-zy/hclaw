import { useState, useCallback } from 'react'

interface CopyButtonProps {
  /** Text to copy to clipboard */
  name: string
  /** Icon size: 'sm' = w-3 h-3, 'md' = w-3.5 h-3.5 (default) */
  size?: 'sm' | 'md'
}

/**
 * Copy-to-clipboard button with copy/check icon feedback.
 * Each instance manages its own copied state, so multiple buttons
 * on the same page work independently.
 */
export function CopyButton({ name, size = 'md' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const doCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(name)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  }, [name])

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    doCopy()
  }, [doCopy])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      doCopy()
    }
  }, [doCopy])

  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10 transition-all flex-shrink-0 cursor-pointer"
      title={copied ? '已复制' : '复制名称'}
      aria-label={copied ? '已复制' : '复制名称'}
    >
      {copied ? (
        <svg className={`${iconSize} text-green-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg className={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </span>
  )
}
