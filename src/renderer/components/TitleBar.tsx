import {useEffect, useState} from 'react'
import {useAgentStore} from '../stores/agentStore'

interface TitleBarProps {
    className?: string
}

export default function TitleBar({className = ''}: TitleBarProps) {
    const {agentState} = useAgentStore()
    const [isMaximized, setIsMaximized] = useState(false)
    const [appVersion, setAppVersion] = useState('')

    // 初始化最大化状态 + 获取版本号
    useEffect(() => {
        window.electronAPI?.isMaximized?.().then(setIsMaximized)
        window.electronAPI?.getAppVersion?.().then(setAppVersion)

        // 监听最大化状态变化
        const unsubscribe = window.electronAPI?.onWindowMaximizedChange?.(setIsMaximized)
        return () => unsubscribe?.()
    }, [])

    return (
        <header
            className={`titlebar ${className}`}
            role="banner"
        >
            {/* 拖拽区域 + 内容 */}
            <div className="titlebar-content">
                {/* Left: Logo */}
                <div className="titlebar-left no-drag">
                    <div className="logo-container">
                        <img
                            src="./icon.png"
                            alt="HClaw"
                            className="logo-icon-img"
                            width="32"
                            height="32"
                            draggable={false}
                        />
                        <span className="logo-text">HClaw <span className="text-[10px] text-[var(--text-muted)] font-normal ml-1">v{appVersion} by Hamlin</span></span>
                    </div>
                </div>

                {/* Center: 拖拽区域 + 当前任务指示器 */}
                <div className="titlebar-center drag-region">
                    <div className="task-indicator">
                        {agentState.currentTask && (
                            <span className="task-text" aria-live="polite">
                                {agentState.currentTask}
                            </span>
                        )}
                    </div>
                </div>

                {/* Right: 自定义窗口控制按钮 */}
                <div className="titlebar-right no-drag">
                    <div className="window-controls">
                        <WindowControlButton
                            icon={<MinimizeIcon/>}
                            onClick={() => window.electronAPI?.minimizeWindow?.()}
                            ariaLabel="最小化"
                        />
                        <WindowControlButton
                            icon={isMaximized ? <RestoreIcon/> : <MaximizeIcon/>}
                            onClick={() => window.electronAPI?.maximizeWindow?.()}
                            ariaLabel={isMaximized ? "还原" : "最大化"}
                        />
                        <WindowControlButton
                            icon={<CloseIcon/>}
                            onClick={() => window.electronAPI?.closeWindow?.()}
                            ariaLabel="关闭"
                            isClose
                        />
                    </div>
                </div>
            </div>
        </header>
    )
}

// ========================================
// 子组件
// ========================================

interface WindowControlButtonProps {
    icon: React.ReactNode
    onClick?: () => void
    ariaLabel: string
    isClose?: boolean
}

function WindowControlButton({icon, onClick, ariaLabel, isClose}: WindowControlButtonProps) {
    return (
        <button
            onClick={onClick}
            aria-label={ariaLabel}
            className={`window-control-btn ${isClose ? 'window-control-btn--close' : ''}`}
        >
            {icon}
        </button>
    )
}

// ========================================
// SVG 图标组件
// ========================================

function MinimizeIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 12H4"/>
        </svg>
    )
}

function MaximizeIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
        </svg>
    )
}

function RestoreIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="6" width="12" height="12" rx="1"/>
            <path d="M8 6V5a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1h-1"/>
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
    )
}
