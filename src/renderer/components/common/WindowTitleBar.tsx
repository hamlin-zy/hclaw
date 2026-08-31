import {useEffect, useState} from 'react'

interface WindowTitleBarProps {
    title: string
}

function MinimizeIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M20 12H4"/>
        </svg>
    )
}

function MaximizeIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
        </svg>
    )
}

function RestoreIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1"/>
            <path d="M8 6V5a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1h-1"/>
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
    )
}

/** 独立无边框窗口的自定义标题栏：拖拽区 + 窗口控制按钮（最小化/最大化/关闭） */
export default function WindowTitleBar({title}: WindowTitleBarProps) {
    const [isMaximized, setIsMaximized] = useState(false)

    useEffect(() => {
        const api = window.electronAPI
        if (!api?.windowControls) return
        void api.windowControls.isMaximized().then(setIsMaximized)
        return api.windowControls.onMaximizedChange(setIsMaximized)
    }, [])

    return (
        <header className="titlebar shrink-0">
            <div className="titlebar-content">
                <div className="titlebar-left no-drag">
                    <div className="logo-container">
                        <span className="logo-text">{title}</span>
                    </div>
                </div>
                <div className="titlebar-center drag-region"/>
                <div className="titlebar-right no-drag">
                    <div className="window-controls">
                        <button className="window-control-btn" onClick={() => window.electronAPI?.windowControls?.minimize?.()} aria-label="最小化" data-name="window-title-bar-button">
                            <MinimizeIcon/>
                        </button>
                        <button className="window-control-btn" onClick={() => window.electronAPI?.windowControls?.maximize?.()} aria-label={isMaximized ? '还原' : '最大化'} data-name="window-title-bar-maximize-button">
                            {isMaximized ? <RestoreIcon/> : <MaximizeIcon/>}
                        </button>
                        <button className="window-control-btn window-control-btn--close" onClick={() => window.electronAPI?.windowControls?.close?.()} aria-label="关闭" data-name="window-title-bar-close-button">
                            <CloseIcon/>
                        </button>
                    </div>
                </div>
            </div>
        </header>
    )
}
