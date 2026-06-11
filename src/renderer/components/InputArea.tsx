import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {motion} from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'
import {useLLMStore} from '../stores/llmStore'
import {useMenuBarStore} from '../stores/menuBarStore'
import {useInputHistoryStore} from '../stores/inputHistoryStore'
import ModelAlertDialog from './ModelAlertDialog'
import AttachedFilesBar from './AttachedFilesBar'
import MarkdownPreviewArea from './MarkdownPreviewArea'
import PendingQuestionCard from './PendingQuestionCard'
import InputToolbar from './InputToolbar'
import {CommandPalette} from './plugin/CommandPalette'

import ImagePreviewModal from './common/ImagePreviewModal'
import {generateFileId} from '../lib/format'


// ★ Markdown 预览防抖 hook（模块级定义，遵循 Rules of Hooks）
const useDebounce = <T,>(value: T, delay: number): T => {
    const [debouncedValue, setDebouncedValue] = useState(value)
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedValue(value), delay)
        return () => clearTimeout(timer)
    }, [value, delay])
    return debouncedValue
}

/** 从 Blob 创建附件条目（右键粘贴/剪贴板粘贴共用） */
async function blobToAttachedFile(blob: Blob): Promise<AttachedFile> {
    const ts = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/:/g, '-')
    const fileName = `截图_${ts}.png`
    const buffer = Array.from(new Uint8Array(await blob.arrayBuffer()))
    const savedPath = await window.electronAPI?.saveTempFile({buffer, name: fileName})
    return {
        id: generateFileId('paste'),
        name: fileName,
        path: savedPath || '',
        size: blob.size,
        type: blob.type,
        isImage: true,
        previewUrl: URL.createObjectURL(blob),
    }
}

/** 去除附件中的临时 blob URL（用于发送消息前清理） */
function stripPreviewUrl(f: AttachedFile) {
    return {id: f.id, name: f.name, path: f.path, size: f.size, type: f.type, isImage: f.isImage}
}

/** 文件类型定义 */
export interface AttachedFile {
    id: string
    name: string
    path: string
    size: number
    type: string
    isImage: boolean
    previewUrl?: string
}

interface InputAreaProps {
    isActive?: boolean
}

export default function InputArea({isActive = true}: InputAreaProps) {
    // ★ 改造：从 convAgentStates 读取当前会话的 agent 状态
    // 而非全局 agentState，使每个会话拥有独立的 agent 运行状态
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const convData = useAgentStore((s) => isActive && activeConversationId ? s.convAgentStates[activeConversationId] : undefined)
    const agentState = convData?.agentState ?? {status: 'idle', mode: 'auto'}
    const startAgent = useAgentStore((s) => s.startAgent)
    const abortAgent = useAgentStore((s) => s.abortAgent)
    const addMessage = useConversationStore((s) => s.addMessage)
    const createConversation = useConversationStore((s) => s.createConversation)
    const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
    const updateConversationMeta = useConversationStore((s) => s.updateConversationMeta)
    const openDialog = useMenuBarStore((s) => s.openDialog)

    // 从 llmStore 获取活跃模型名称（用于展示）
    const activeModelName = useLLMStore((s) => {
        const provider = s.providers.find((p) => p.id === s.activeProviderId)
        const model = provider?.models.find((m) => m.id === s.activeModelId)
        return model?.name || null
    })

    const [input, setInput] = useState('')
    const [isDragging, setIsDragging] = useState(false)
    const [showModelAlert, setShowModelAlert] = useState(false)
    const [isPreviewMode, setIsPreviewMode] = useState(false)
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
    // 输入历史导航
    const [historyIndex, setHistoryIndex] = useState(-1) // -1 = 当前输入
    const [savedInput, setSavedInput] = useState('') // 进入历史模式时保存当前输入
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // ★ Markdown 预览防抖：打字时不卡顿，松手 150ms 后更新预览
    const debouncedInput = useDebounce(input, 150)
    const markdownPreview = useMemo(() => (
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{
                p: ({children}) => <p className="mb-2 last:mb-0">{children}</p>,
                h1: ({children}) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
                h2: ({children}) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
                h3: ({children}) => <h3 className="text-xs font-bold mb-2 mt-2 first:mt-0 uppercase tracking-wider">{children}</h3>,
                code: ({children}) => <code className="px-1 py-0.5 rounded bg-[var(--brand-muted)] text-[var(--brand-primary)] font-mono text-[11px]">{children}</code>,
                ul: ({children}) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
                ol: ({children}) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
                li: ({children}) => <li className="ml-1">{children}</li>,
                table: ({children}) => <table className="min-w-full divide-y divide-[var(--border)] text-[11px] my-2 border border-[var(--border)] rounded">{children}</table>,
                th: ({children}) => <th className="px-2 py-1 bg-[var(--surface-muted)] font-bold">{children}</th>,
                td: ({children}) => <td className="px-2 py-1 border-t border-[var(--border)]">{children}</td>,
            }}
        >
            {debouncedInput}
        </ReactMarkdown>
    ), [debouncedInput])

    // 高度状态
    const [previewHeight, setPreviewHeight] = useState<number | null>(null) // null 表示使用默认值

    // DOM 引用
    const previewContainerRef = useRef<HTMLDivElement>(null)

    // 文件附件状态
    const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
    const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
    /** 积压附件：用户先发文件后发指令时使用 */
    const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<AttachedFile[]>([])

    // 清理附件的辅助函数
    const clearAttachedFiles = useCallback(() => {
        attachedFiles.forEach(f => {
            if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
        })
        setAttachedFiles([])
    }, [attachedFiles])

    // 生成附件预览信息（用于显示在消息气泡上方）
    // 注意: 不传递 previewUrl (blob URL)，因为它是临时的，消息发送后会被 revoke
    // AttachmentPreview 组件会通过 filePath 从磁盘加载实际文件
    const getAttachmentsForMessage = useCallback(() => {
        if (attachedFiles.length === 0) return []
        return attachedFiles.map(f => ({
            id: f.id,
            name: f.name,
            type: f.type,
            size: f.size,
            path: f.path,
            isImage: f.isImage,
        }))
    }, [attachedFiles])


    // 预览区域拖拽调整高度
    const handlePreviewResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        const previewContainer = previewContainerRef.current
        if (!previewContainer) return

        // 获取当前高度和鼠标位置作为基准
        const containerRect = previewContainer.getBoundingClientRect()
        const initialMouseY = e.clientY
        const initialHeight = containerRect.height

        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'

        const handleMouseMove = (moveEvent: MouseEvent) => {
            // 计算鼠标相对移动量，鼠标移动多少，高度就增减多少
            const deltaY = moveEvent.clientY - initialMouseY
            setPreviewHeight(initialHeight + deltaY)
        }

        const handleMouseUp = () => {
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
    }, [])

    /** 提交消息的内部逻辑，支持可选的 metadata */
    const submitMessage = async (text: string, options?: { metadata?: Record<string, unknown> }) => {
        // 确保有会话
        if (!activeConversationId) {
            const newId = await createConversation()
            setActiveConversation(newId)
        }
        const convId = useConversationStore.getState().activeConversationId
        if (!convId) return

        // ── 附件积压/合并逻辑 ──
        const currentAttachments = getAttachmentsForMessage()
        const hasText = text.trim().length > 0

        // 合并积压附件 + 当前附件（统一剥离临时 blob URL）
        const mergedAttachments = [
            ...pendingAttachmentFiles.map(stripPreviewUrl),
            ...currentAttachments,
        ]
        const hasAnyFiles = mergedAttachments.length > 0

        // ── 纯附件积压（无文字但有文件）──
        if (hasAnyFiles && !hasText) {
            const savedFiles = [
                ...pendingAttachmentFiles.map(f => ({...f, previewUrl: undefined})),
                ...attachedFiles.map(f => ({...f, previewUrl: undefined})),
            ]
            setPendingAttachmentFiles(savedFiles)

            addMessage({
                role: 'user',
                content: '(附件已保存，请发送指令)',
                attachments: mergedAttachments,
                metadata: options?.metadata,
            })
            setInput('')
            clearAttachedFiles()
            textareaRef.current?.focus()
            return
        }

        // ── 有文字的提交 ──
        setPendingAttachmentFiles([])

        // 记录到输入历史（持久化）
        useInputHistoryStore.getState().pushEntry(text)

        // 添加消息（含合并后的附件）
        addMessage({
            role: 'user',
            content: text,
            attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
            metadata: options?.metadata,
        })

        // 自动重命名默认标题
        const wsPath = useConversationStore.getState().currentWorkspacePath
        const convList = wsPath ? useConversationStore.getState().workspaces[wsPath]?.conversations : []
        const currentConv = convList?.find(c => c.id === convId)
        if (currentConv?.title === '新对话') {
            updateConversationMeta(convId, {
                title: text.slice(0, 30) + (text.length > 30 ? '...' : ''),
                preview: text.slice(0, 30)
            })
        }

        setInput('')
        // 重置历史导航状态
        setHistoryIndex(-1)
        setSavedInput('')
        clearAttachedFiles()
        textareaRef.current?.focus()

        // ★ 判断是否在运行中 → 走队列 + 实时注入 / 直接启动
        const convState = useAgentStore.getState().convAgentStates[convId]
        const isRunningNow = convState?.agentState.status === 'running' || convState?.agentState.status === 'thinking'
        if (isRunningNow) {
            // 运行时：先尝试实时注入到运行中的 Agent Worker（不中断）
            // ── pendingMessages 是兜底机制 ──────────────────────────────
            // 注入成功后消息会进入 worker 的 pendingInjectedMessages 队列，
            // 由 Controller 在下一轮 LLM 调用前取走处理。只有注入失败时才
            // 加入待处理队列（loop 结束后会从中取出启动新 loop 重试）。
            const injected = await window.electronAPI?.agentInjectMessage?.({
                conversationId: convId,
                content: text,
            })
            if (!injected?.success) {
                useAgentStore.getState().updateConvData(convId, {
                    pendingMessages: [
                        ...(useAgentStore.getState().convAgentStates[convId]?.pendingMessages || []),
                        {
                            content: text,
                            attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
                            metadata: options?.metadata,
                        }
                    ]
                })
            }
        } else {
            // 空闲时：启动 Agent，传递合并后的附件
            startAgent({
                conversationId: convId,
                message: text,
                messageAttachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
                messageMetadata: options?.metadata,
            })
        }
    }

    /** 提交当前输入框中的内容，支持 / 前缀命令检测 */
    const handleSubmit = async () => {
        const text = input.trim()
        const hasFiles = attachedFiles.length > 0 || pendingAttachmentFiles.length > 0
        if (!text && !hasFiles) return

        // 纯附件（无文字但有文件）：直接进入 submitMessage 的积压逻辑
        if (!text && hasFiles) {
            await submitMessage('')
            return
        }

        // 检测 / 前缀命令
        if (text.startsWith('/') && !text.startsWith('//')) {
            const cmdMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
            if (cmdMatch) {
                const cmdName = cmdMatch[1];
                const cmdArgs = cmdMatch[2];

                try {
                    // 解析命令名称（先用户命令，再插件命令）
                    const resolved = await window.electronAPI?.commandResolveByName?.(cmdName, cmdArgs);
                    if (resolved?.template && resolved?.commandId) {
                        const displayMessage = cmdArgs ? `/${cmdName} ${cmdArgs}` : `/${cmdName}`;
                        await handleSubmitWithMessage(displayMessage, {
                            metadata: {
                                commandTemplate: resolved.template,
                                commandId: resolved.commandId,
                                commandArgs: cmdArgs,
                            }
                        });
                        return;
                    }
                } catch {
                    // 解析失败，回退到普通消息
                }
            }
        }

        // 不匹配 / 命令，走普通提交
        submitMessage(text)
    }

    /** 从外部提交消息（如选项点击），支持 metadata */
    const handleSubmitWithMessage = (text: string, options?: { metadata?: Record<string, unknown> }) => {
        submitMessage(text, options)
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // Enter (不含 Shift/Ctrl/Meta) → 发送
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            handleSubmit()
            return
        }

        // Ctrl+↑ → 输入历史（上翻）
        if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp') {
            e.preventDefault()
            const history = useInputHistoryStore.getState().history
            if (history.length === 0) return

            // 首次进入历史模式，保存当前输入
            if (historyIndex === -1) {
                setSavedInput(input)
                setHistoryIndex(history.length - 1)
                setInput(history[history.length - 1])
            } else {
                const newIndex = Math.max(0, historyIndex - 1)
                setHistoryIndex(newIndex)
                setInput(history[newIndex])
            }
            return
        }

        // Ctrl+↓ → 输入历史（下翻）
        if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown') {
            e.preventDefault()
            if (historyIndex === -1) return

            const history = useInputHistoryStore.getState().history
            if (historyIndex >= history.length - 1) {
                // 回到当前输入
                setHistoryIndex(-1)
                setInput(savedInput)
                setSavedInput('')
            } else {
                const newIndex = historyIndex + 1
                setHistoryIndex(newIndex)
                setInput(history[newIndex])
            }
            return
        }
    }

    // 监听全局快捷键事件：Ctrl+K → 打开命令选择弹窗（仅活跃会话响应）
    useEffect(() => {
        if (!isActive) return
        const handler = () => setCommandPaletteOpen(prev => !prev)
        window.addEventListener('hclaw:toggle-command-palette', handler)
        return () => window.removeEventListener('hclaw:toggle-command-palette', handler)
    }, [isActive])

    // 监听 Ctrl+N 新建会话后焦点输入框（仅活跃会话响应）
    useEffect(() => {
        if (!isActive) return
        const handler = () => {
            textareaRef.current?.focus()
        }
        window.addEventListener('hclaw:focus-input', handler)
        return () => window.removeEventListener('hclaw:focus-input', handler)
    }, [isActive])


    // 右键菜单粘贴处理（支持图片和文字）
    const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation() // 防止全局 contextmenu 处理器重复触发

        // 尝试处理图片粘贴
        try {
            const clipboardItems = await navigator.clipboard.read()
            for (const item of clipboardItems) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        const blob = await item.getType(type)
                        const file = await blobToAttachedFile(blob)
                        setAttachedFiles(prev => [...prev, file])
                        return
                    }
                }
            }
        } catch {
            // 剪贴板读取失败，尝试降级处理文字
        }

        // 处理文字粘贴
        try {
            const text = await navigator.clipboard.readText()
            if (!text || !textareaRef.current) return
            const textarea = textareaRef.current
            const pos = textarea.selectionStart
            const newValue = textarea.value.slice(0, pos) + text + textarea.value.slice(textarea.selectionEnd)
            setInput(newValue)
            requestAnimationFrame(() => {
                textarea.selectionStart = textarea.selectionEnd = pos + text.length
                textarea.focus()
            })
        } catch {
            // 剪贴板读取失败
        }
    }, [])

    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault()
        setIsDragging(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length === 0) return

        // sandbox 模式下 Electron 不暴露 file.path，通过 preload 的 webUtils 获取
        // 将拖入的文件复制到持久化 temp 目录，避免原始文件被移动/删除后失效
        const savedFiles = await Promise.all(files.map(async (file) => {
            const sourcePath = window.electronAPI?.getDroppedFilePath?.(file) || file.name
            let stablePath: string | null = null
            if (sourcePath) {
                stablePath = await window.electronAPI?.saveDroppedFile?.({sourcePath, name: file.name}) ?? null
            }
            const isImage = file.type.startsWith('image/')
            return {
                id: generateFileId('drop'),
                name: file.name,
                path: stablePath || sourcePath,
                size: file.size,
                type: file.type,
                isImage,
                previewUrl: isImage ? URL.createObjectURL(file) : undefined,
            }
        }))
        setAttachedFiles(prev => [...prev, ...savedFiles])
    }, [])

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(true)
    }, [])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(false)
    }, [])

    const isRunning = agentState.status === 'running' || agentState.status === 'thinking'
    const isPaused = agentState.status === 'paused'
    // ★ 改造：从 convData 读取当前会话的 pendingQuestion
    const pendingQuestion = convData?.pendingQuestion ?? null
    const respondQuestion = useAgentStore((s) => s.respondQuestion)
    const compactInProgress = useAgentStore((s) => s.compactInProgress)

    // 有文本 或 附件 或 [文件名] 徽章时允许发送
    const hasBadgeContent = /\[[^\]]+\]/.test(input.trim())
    const canSend = (input.trim().length > 0 || attachedFiles.length > 0 || hasBadgeContent) && !isPaused
    const needsSession = !activeConversationId
    const needsModel = !activeModelName

    // 响应确认请求
    const handleAction = async (action: 'allow' | 'always' | 'deny') => {
        await respondQuestion(action)
    }

    // 终止 Agent 执行
    const handleAbort = useCallback(async () => {
        const convId = useConversationStore.getState().activeConversationId
        if (convId) {
            await abortAgent(convId)
        }
    }, [abortAgent])

    // 处理命令执行：从 CommandPalette 选择的命令
    // displayMessage 是显示用的简洁消息（/commandName [args]）
    // 完整模板存储在 metadata 中，供 Agent Loop 使用
    const handleExecuteCommand = useCallback(async (
        commandId: string,
        args: string | undefined,
        displayMessage: string
    ) => {
        try {
            // 通过 IPC 获取命令的完整提示词模板
            const template = await window.electronAPI?.commandPrepareMessage(commandId, args)

            // 使用 displayMessage 作为用户消息显示，模板存储在 metadata 中
            // 这样用户看到的是简洁的 /commandName [args]，而不是冗长的模板内容
            await handleSubmitWithMessage(displayMessage, {
                metadata: {
                    commandTemplate: template,
                    commandId: commandId,
                    commandArgs: args,
                }
            })
        } catch (err) {
            // 静默处理错误
        }
        setCommandPaletteOpen(false)
    }, [handleSubmitWithMessage])

    // 工具：在 textarea 指定位置插入文本并聚焦
    const insertAtCursor = useCallback((insert: string, prefixLen: number = 0) => {
        const ta = textareaRef.current
        if (!ta) return null
        const cursor = ta.selectionStart
        const before = input.slice(0, cursor - prefixLen)
        const after = input.slice(cursor)
        const result = (before + insert + after).replace(/^\s*/, '').trimStart()
        setInput(result)
        const newPos = before.length + insert.length
        requestAnimationFrame(() => {
            ta.focus();
            ta.selectionStart = ta.selectionEnd = newPos
        })
        return result
    }, [input])

    // 处理剪贴板粘贴（支持图片）
    const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items
        if (!items) return

        // 处理图片粘贴
        const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'))
        if (imageItems.length > 0) {
            e.preventDefault() // 阻止默认粘贴行为
            for (const item of imageItems) {
                const blob = item.getAsFile()
                if (!blob) continue
                const file = await blobToAttachedFile(blob)
                setAttachedFiles(prev => [...prev, file])
            }
        }
    }, [])

    return (
        <div
            className="px-3 pt-3 pb-1 border-[var(--border)] bg-[var(--surface)] flex flex-col"
            data-input-area
        >
            {/* Model Alert Dialog */}
            <ModelAlertDialog
                open={showModelAlert}
                onClose={() => setShowModelAlert(false)}
                onConfigure={() => {
                    setShowModelAlert(false)
                    window.dispatchEvent(new CustomEvent('hclaw:open-llm-config'))
                }}
            />

            {/* Drag overlay */}
            <motion.div
                initial={false}
                animate={{opacity: isDragging ? 1 : 0}}
                className="absolute inset-0 bg-brand-50/90 flex items-center justify-center pointer-events-none z-10"
            >
                <div className="text-center">
                    <svg className="w-8 h-8 mx-auto mb-1 text-brand-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <p className="text-brand-500 text-sm font-medium">释放以添加文件</p>
                </div>
            </motion.div>

            {/* Hint banner */}
            {needsSession && (
                <div role="alert"
                     className="mb-2 px-3 py-2 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)] text-xs text-[var(--warning)]">
                    请先在左侧选择一个工作目录和会话，或点击「新建对话」
                </div>
            )}

            <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                className="relative transition-all flex flex-col"
                role="region"
                aria-label="文件放置区域"
            >
                {/* 文件预览条 */}
                <AttachedFilesBar
                    files={attachedFiles}
                    onRemove={(fileId) => {
                        const file = attachedFiles.find(f => f.id === fileId)
                        if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl)
                        setAttachedFiles(attachedFiles.filter(f => f.id !== fileId))
                    }}
                    onPreview={(url) => setPreviewImageUrl(url)}
                    onOpenFile={(path) => window.electronAPI?.openPath(path)}
                    onClearAll={clearAttachedFiles}
                />

                {/* 用户提问条 - 用于 ask_user 工具（无 requestId） */}
                <PendingQuestionCard
                    isPaused={isPaused}
                    pendingQuestion={pendingQuestion}
                    onSelectOption={(option) => handleSubmitWithMessage(option)}
                />

                {/* Input */}
                <div className={`relative ${isPaused ? 'border-[var(--brand-primary)]' : 'focus-within:border-[var(--brand-primary)]'}`}>
                    {/* 实时预览层 */}
                    <MarkdownPreviewArea
                        isVisible={isPreviewMode && debouncedInput.trim().length > 0}
                        content={markdownPreview}
                        maxHeight={previewHeight}
                        onResizeStart={handlePreviewResizeStart}
                    />

                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => {
                            setInput(e.target.value)
                        }}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        onContextMenu={handleContextMenu}
                        placeholder={needsSession ? '请先选择工作目录和会话...' : '输入你的任务，让 HClaw 开始工作...'}
                        className="w-full px-3 py-2.5 bg-[var(--surface)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none outline-none ring-0 focus:ring-0 focus:outline-none border-0"
                        style={{minHeight: '120px'}}
                        rows={3}
                    />

                    {/* 底部工具栏 */}
                    <InputToolbar
                        isRunning={isRunning}
                        compactInProgress={compactInProgress}
                        needsSession={needsSession}
                        needsModel={needsModel}
                        agentState={agentState as {currentModelProvider?: string; currentModelName?: string}}
                        pendingMessagesCount={convData?.pendingMessages?.length ?? 0}
                        isPreviewMode={isPreviewMode}
                        canSend={canSend}
                        onTogglePreview={() => setIsPreviewMode(prev => !prev)}
                        onSubmit={handleSubmit}
                        onAbort={handleAbort}
                        onUploadFile={(files) => setAttachedFiles(prev => [...prev, ...files])}
                        onOpenDialog={openDialog}
                        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
                    />
                </div>
            </div>
            {/* 命令面板 */}
            <CommandPalette
                isOpen={commandPaletteOpen}
                onClose={() => setCommandPaletteOpen(false)}
                onExecuteCommand={handleExecuteCommand}
            />


            {/* 图片预览弹窗（仅活跃会话） */}
            {isActive && previewImageUrl && (
                <ImagePreviewModal
                    src={previewImageUrl}
                    alt="截图预览"
                    onClose={() => setPreviewImageUrl(null)}
                />
            )}
        </div>
    )
}
