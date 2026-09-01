import {useEffect, useState} from 'react'
import WindowTitleBar from './common/WindowTitleBar'

/**
 * 内置浏览器窗口外壳（dialogWindow.html 渲染入口，--hclaw-dialog=builtin-browser）
 *
 * 标题栏文本跟随网站标题（主进程 page-title-updated 经 onPageTitle 推送）；
 * 网站内容由主进程 WebContentsView 叠加在下方的占位区域之上，
 * 网页首次加载完成前显示加载动画（WebContentsView 绘制慢，避免黑屏观感）。
 */
export default function BrowserShellWindow() {
    const [title, setTitle] = useState('HClaw 内置浏览器')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const offTitle = window.electronAPI?.windowControls?.onPageTitle?.(setTitle)
        const offLoaded = window.electronAPI?.windowControls?.onPageLoaded?.(() => setLoading(false))
        return () => {
            offTitle?.()
            offLoaded?.()
        }
    }, [])

    return (
        <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
            <WindowTitleBar title={title}/>
            {/* 占位区域：主进程 WebContentsView 覆盖于此（含 1px 标题栏下边框） */}
            <div className="relative flex-1 min-h-0">
                {loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--surface)] z-10">
                        <div
                            className="w-8 h-8 rounded-full border-2 border-[var(--border)] border-t-[var(--brand-primary)] animate-spin"
                            data-name="builtin-browser-loading"
                        />
                        <span className="text-xs text-[var(--text-muted)]">页面加载中…</span>
                    </div>
                )}
            </div>
        </div>
    )
}
