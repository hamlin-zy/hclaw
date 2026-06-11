import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettingsStore } from '../../stores/settingsStore'
import LinkContextMenu from '../common/LinkContextMenu'

interface LinkItem {
  label: string
  url: string
  icon: React.ReactNode
}

/** GitHub 图标 */
function GithubSvg() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  )
}

/** Gitee 图标 — code/merge 分支风格 */
function GiteeSvg() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
    </svg>
  )
}

/** B站图标 — TV + 按钮 */
function BilibiliSvg() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="13" rx="3" />
      <path d="M9 2l-3 5" />
      <path d="M15 2l3 5" />
      <circle cx="9" cy="14" r="1" fill="currentColor" />
      <circle cx="15" cy="14" r="1" fill="currentColor" />
      <path d="M7 14h10" />
    </svg>
  )
}

/** 抖音图标 — 音乐符号风格 */
function DouyinSvg() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}

const LINKS: LinkItem[] = [
  { label: 'GitHub', url: 'https://github.com/hamlin-zy/hclaw', icon: <GithubSvg /> },
  { label: 'Gitee', url: 'https://gitee.com/sunshao/hclaw', icon: <GiteeSvg /> },
  { label: 'B站', url: 'https://space.bilibili.com/3707005250308201', icon: <BilibiliSvg /> },
  { label: '抖音', url: 'https://v.douyin.com/BBGiozWD36o/', icon: <DouyinSvg /> },
]

export default function AboutDialog() {
  const [appVersion, setAppVersion] = useState('')
  const {settings} = useSettingsStore()
  const linkMode = settings.linkOpening?.mode ?? 'ask'
  const [linkMenu, setLinkMenu] = useState<{visible: boolean; x: number; y: number; url: string}>({
    visible: false, x: 0, y: 0, url: ''
  })

  useEffect(() => {
    window.electronAPI?.getAppVersion?.().then(setAppVersion).catch(() => setAppVersion(''))
  }, [])

  const handleLinkClick = useCallback((url: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (linkMode === 'builtin') {
      window.electronAPI?.openBuiltin?.(url)
    } else if (linkMode === 'system') {
      window.electronAPI?.openSystem?.(url)
    } else {
      // ask: 复用 LinkContextMenu
      const rect = e.currentTarget.getBoundingClientRect()
      setLinkMenu({visible: true, x: rect.left + rect.width / 2, y: rect.bottom, url})
    }
  }, [linkMode])

  return (
    <div className="flex flex-col items-center pt-7 pb-6 px-8 h-full overflow-y-auto">
      {/* Icon */}
      <div className="w-14 h-14 rounded-2xl overflow-hidden mb-3 flex-shrink-0 shadow-sm"
        style={{ backgroundColor: 'var(--surface-muted)' }}>
        <img src="./icon.png" alt="HClaw" className="w-full h-full object-cover" draggable={false} />
      </div>

      {/* App Name & Version */}
      <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>HClaw</h1>
      <p className="text-xs mb-3 font-mono" style={{ color: 'var(--text-muted)' }}>v{appVersion || '...'}</p>

      {/* Author */}
      <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>作者：Hamlin</p>

      {/* Divider */}
      <div className="w-full h-px mb-4" style={{ backgroundColor: 'var(--border)' }} />

      {/* Links Grid — 2x2 */}
      <div className="grid grid-cols-2 gap-2.5 w-full max-w-[300px]">
        {LINKS.map((link) => (
          <button
            key={link.label}
            onClick={(e) => handleLinkClick(link.url, e)}
            className="flex flex-col items-center justify-center gap-1.5 px-3 py-3 rounded-xl text-xs
              text-[var(--text-secondary)] bg-[var(--surface)] border border-[var(--border)]
              hover:border-[var(--brand-primary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]
              transition-all duration-150"
          >
            <span className="w-4 h-4 flex items-center justify-center text-[var(--text-muted)]">
              {link.icon}
            </span>
            <span>{link.label}</span>
          </button>
        ))}
      </div>

      {/* LinkContextMenu for 'ask' mode */}
      {createPortal(
        <LinkContextMenu
          visible={linkMenu.visible}
          x={linkMenu.x}
          y={linkMenu.y}
          url={linkMenu.url}
          onClose={() => setLinkMenu(prev => ({...prev, visible: false}))}
        />,
        document.body
      )}
    </div>
  )
}
