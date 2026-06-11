import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'
import {type ReactNode, useRef, useState} from 'react'
import {generateFileId} from '../lib/format'

interface MenuButtonProps {
    icon: ReactNode
    label: string
    onClick: () => void
}

function MenuButton({icon, label, onClick}: MenuButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
        >
            <svg className="w-4 h-4 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                {icon}
            </svg>
            <span>{label}</span>
        </button>
    )
}

interface ToolMenuProps {
    onUploadFile: (files: {id: string; name: string; path: string; size: number; type: string; isImage: boolean; previewUrl?: string}[]) => void
    onOpenDialog: (...args: any[]) => void
    onOpenCommandPalette: () => void
}

/**
 * "+" 工具菜单按钮 — 点击后从按钮上方弹出菜单（通过 Portal 避免 overflow 裁剪）
 */
export default function ToolMenu({onUploadFile, onOpenDialog, onOpenCommandPalette}: ToolMenuProps) {
    const [toolMenuOpen, setToolMenuOpen] = useState(false)
    const toolBtnRef = useRef<HTMLDivElement>(null)
    const [toolMenuPos, setToolMenuPos] = useState<{bottom: number; right: number} | null>(null)

    const closeMenu = () => {
        setToolMenuOpen(false)
        setToolMenuPos(null)
    }

    return (
        <div className="relative" ref={toolBtnRef}>
            <button
                type="button"
                onClick={() => {
                    if (!toolMenuOpen && toolBtnRef.current) {
                        const rect = toolBtnRef.current.getBoundingClientRect()
                        // 从按钮上方弹出：菜单底部 = 按钮顶部 - 4px 间距；菜单右边缘对齐按钮右边缘
                        setToolMenuPos({bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right})
                    } else {
                        setToolMenuPos(null)
                    }
                    setToolMenuOpen(!toolMenuOpen)
                }}
                className={`py-2 px-1 rounded-md transition-colors ${
                    toolMenuOpen
                        ? 'text-[var(--brand-primary)] bg-[var(--brand-muted)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                }`}
                title="更多工具"
            >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
            </button>

            <AnimatePresence>
                {toolMenuOpen && (
                    <>
                        <motion.div
                            initial={{opacity: 0}}
                            animate={{opacity: 1}}
                            exit={{opacity: 0}}
                            className="fixed inset-0 z-40"
                            onClick={closeMenu}
                        />
                        {toolMenuPos && createPortal(
                            <motion.div
                                initial={{opacity: 0, y: 8, scale: 0.96}}
                                animate={{opacity: 1, y: 0, scale: 1, transition: {duration: 0.15, ease: 'easeOut'}}}
                                exit={{opacity: 0, y: 8, scale: 0.96, transition: {duration: 0.1, ease: 'easeIn'}}}
                                style={{position: 'fixed', bottom: toolMenuPos.bottom, right: toolMenuPos.right, zIndex: 50}}
                                className="w-auto min-w-[140px] bg-[var(--surface-elevated)] border border-[var(--border)] rounded-xl shadow-overlay overflow-hidden py-1"
                            >
                                <MenuButton
                                    icon={<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>}
                                    label="上传文件"
                                    onClick={() => {
                                        closeMenu()
                                        const el = document.createElement('input')
                                        el.type = 'file'
                                        el.multiple = true
                                        el.onchange = (e) => {
                                            const files = (e.target as HTMLInputElement).files
                                            if (!files) return
                                            const newFiles = Array.from(files).map((file) => {
                                                const isImage = file.type.startsWith('image/')
                                                return {
                                                    id: generateFileId('file'),
                                                    name: file.name,
                                                    path: (file as any).path || file.name,
                                                    size: file.size,
                                                    type: file.type,
                                                    isImage,
                                                    previewUrl: isImage ? URL.createObjectURL(file) : undefined,
                                                }
                                            })
                                            onUploadFile(newFiles)
                                        }
                                        el.click()
                                    }}
                                />
                                <MenuButton icon={<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>} label="工具列表 + MCP" onClick={() => { closeMenu(); onOpenDialog('tool-list') }}/>
                                <MenuButton icon={<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>} label="系统提示词" onClick={() => { closeMenu(); onOpenDialog('system-prompt') }}/>
                                <MenuButton icon={<path d="M13 10V3L4 14h7v7l9-11h-7z"/>} label="技能命令" onClick={() => { closeMenu(); onOpenCommandPalette() }}/>
                            </motion.div>,
                            document.body
                        )}
                    </>
                )}
            </AnimatePresence>
        </div>
    )
}
