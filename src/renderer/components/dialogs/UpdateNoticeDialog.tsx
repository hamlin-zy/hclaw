/**
 * 更新通知弹窗
 *
 * 触发时机：
 *   - App 启动静默检查发现新版本（自动弹）
 *   - 用户在关于页面点「检查更新」发现新版本（自动弹）
 *
 * 行为：
 *   - 三个按钮：GitHub 下载 / 网盘下载 / 稍后更新
 *   - 点 GitHub/网盘：打开下载页 + 关闭弹窗（不标记 ignored）
 *   - 点稍后更新：关闭弹窗 + 标记 ignored（本次会话不再弹）
 *   - 不能主动关闭（无 X、无 ESC、无 backdrop 关闭）
 *
 * 变更内容（Task 4）：
 *   - 最新版本条目默认展开（tag 徽章 + title + date + items 列表，items 区可滚动、有高度上限）
 *   - 更早版本收进折叠区（点击行展开该版本 items，默认全收起）
 *   - changelog 为空时不渲染展示区（防御）
 *   - 跨版本时头部版本行显示 `v{current} → v{latest} · 跨越 N 个版本`
 */

import { useCallback, useState } from 'react'
import { useUpdaterStore } from '../../stores/updaterStore'
import { useMenuBarStore } from '../../stores/menuBarStore'
import { splitChangelog, formatVersionRange } from '../../lib/changelogView'
import { ChangelogEntryHeader, ChangelogItemList } from './ChangelogView'

export default function UpdateNoticeDialog() {
  const result = useUpdaterStore((s) => s.result)
  const setIgnored = useUpdaterStore((s) => s.setIgnored)
  const closeDialog = useMenuBarStore((s) => s.closeDialog)
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set())

  const toggleVersion = useCallback((version: string) => {
    setExpandedVersions((prev) => {
      const next = new Set(prev)
      if (next.has(version)) {
        next.delete(version)
      } else {
        next.add(version)
      }
      return next
    })
  }, [])

  const close = useCallback(() => {
    closeDialog()
  }, [closeDialog])

  const handleGithub = useCallback(() => {
    if (result?.downloads?.github) {
      window.electronAPI?.openSystem?.(result.downloads.github)
    }
    close()
  }, [result, close])

  const handleBaidu = useCallback(() => {
    if (result?.downloads?.baiduPan) {
      window.electronAPI?.openSystem?.(result.downloads.baiduPan)
    }
    close()
  }, [result, close])

  const handleLater = useCallback(() => {
    setIgnored()
    close()
  }, [setIgnored, close])

  // 防御性兜底：理论上 dialog 系统不会在没有 update-available 时打开这个弹窗
  if (result?.status !== 'update-available') {
    return null
  }

  // changelog 为空时不渲染展示区（契约：消费方须防御）
  const changelog = result.changelog
  const { latest, older } = splitChangelog(changelog)
  const versionRange = formatVersionRange(
    result.currentVersion,
    result.latestVersion,
    changelog.length
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部 icon + 标题 */}
      <div className="flex flex-col items-center shrink-0 pt-8 pb-5 px-6">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
          style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)' }}
        >
          {/* 上箭头 icon：代表"有新版本可升" */}
          <svg
            className="w-6 h-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'rgb(239, 68, 68)' }}
            aria-hidden="true"
          >
            <path d="M12 19V5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </div>
        <h2
          className="text-base font-semibold mb-1"
          style={{ color: 'var(--text-primary)' }}
        >
          发现新版本
        </h2>
        <p
          className="text-sm font-mono"
          style={{ color: 'var(--text-secondary)' }}
        >
          {versionRange ?? `v${result.latestVersion}`}
        </p>

        {/* 最新版本条目：tag 徽章 + title + date */}
        {latest && (
          <div
            className="w-full mt-3 rounded-[10px] overflow-hidden select-text"
            style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
          >
            <ChangelogEntryHeader
              entry={latest}
              className="flex items-center gap-2 px-[14px] py-[9px] min-w-0"
              titleClassName="flex-1 min-w-0 truncate text-[12.5px] font-semibold"
              dateClassName="shrink-0 text-[11px]"
              dateText={latest.date}
            />
          </div>
        )}
      </div>

      {/* 变更内容区：最新条目 items + 跨版本折叠列表 */}
      {latest && (
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto px-6 pb-4 select-text">
          <div
            className="w-full shrink-0 overflow-y-auto px-[14px] py-3 rounded-[10px] mb-3"
            style={{
              background: 'var(--surface-muted)',
              border: '1px solid var(--border-muted)',
              maxHeight: '120px',
            }}
          >
            <ChangelogItemList
              items={latest.items}
              className="text-xs leading-[18px] mb-[7px] last:mb-0"
            />
          </div>

          {older.length > 0 && (
            <div
              className="w-full shrink-0 rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--border-muted)', background: 'var(--surface)' }}
            >
              {older.map((entry, i) => {
                const expanded = expandedVersions.has(entry.version)
                return (
                  <div
                    key={entry.version}
                    style={i > 0 ? { borderTop: '1px solid var(--border-muted)' } : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => toggleVersion(entry.version)}
                      aria-expanded={expanded}
                      className="w-full flex items-center gap-2 px-3 py-[7px] text-left
                        hover:bg-[var(--surface-muted)] transition-colors"
                      style={{ color: 'var(--text-secondary)' }}
                      data-name="update-version-row"
                    >
                      <span className="shrink-0 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                        {expanded ? '▼' : '▶'}
                      </span>
                      <span className="shrink-0 text-[11px] font-mono">{entry.version}</span>
                      <span className="flex-1 min-w-0 truncate text-xs">{entry.title}</span>
                      <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {entry.date.slice(5)}
                      </span>
                    </button>
                    {expanded && (
                      <div
                        className="px-6 py-2"
                        style={{ borderTop: '1px solid var(--border-muted)' }}
                      >
                        <ChangelogItemList
                          items={entry.items}
                          className="text-[11px] leading-[17px] mb-[6px] last:mb-0"
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 底部按钮区：固定不动 */}
      <div className="border-t px-4 py-3 mt-auto" style={{ borderColor: 'var(--border)' }}>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button
            onClick={handleGithub}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
              bg-[var(--brand-primary)] text-white hover:opacity-90 active:scale-[0.98] transition-all"
           data-name="update-notice-dialog-button">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            GitHub 下载
          </button>
          <button
            onClick={handleBaidu}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
              bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)]
              hover:border-[var(--border-emphasis)] active:scale-[0.98] transition-all"
           data-name="update-notice-dialog-baidu-download-button">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            网盘下载
          </button>
        </div>
        <button
          onClick={handleLater}
          className="w-full px-3 py-2 rounded-lg text-xs
            text-[var(--text-secondary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]
            transition-colors"
         data-name="update-notice-dialog-later-button">
          稍后更新
        </button>
      </div>
    </div>
  )
}