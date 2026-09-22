// 记忆管理窗口（memory-manager，Task 4）
// 左侧：记忆文件树（用户偏好 / 项目记忆 + 归档卷）
// 右侧：Markdown 预览（默认）/ CodeMirror 编辑态（MemoryEditor 包装，受控 onChange）
// 删除走右键菜单 + ConfirmDialog；未保存修改在切换文件（store 内结算）与模式切换时提示。
import {useState, useEffect, useCallback, useRef} from 'react'
import {useMemoryManagerStore} from '../../stores/memoryManagerStore'
import {buildTreeData, type TreeNodeData} from '../../lib/memoryTree'
import {TreeNode} from '../common/TreeNode'
import {MarkdownPreview} from '../../project-manager/components/MarkdownPreview'
import MemoryEditor from './MemoryEditor'
import {confirm} from '../ConfirmDialog'

// --- Icons（颜色全部走 CSS 变量，四主题适配） ---

function FolderIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--text-muted)]">
            <path d="M1.5 2.5h4l1.5 2h7.5v8.5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V2.5z" stroke="currentColor" fill="var(--surface-muted)"/>
        </svg>
    )
}

function FileIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--text-muted)]">
            <path d="M3 1.5h6l3.5 3.5v9a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z" stroke="currentColor"/>
        </svg>
    )
}

function ArchiveIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--text-muted)]">
            <rect x="2" y="3" width="12" height="3" rx="0.5" stroke="currentColor"/>
            <path d="M3.5 6.5v6.5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V6.5M6.5 9h3" stroke="currentColor"/>
        </svg>
    )
}

function nodeIcon(node: TreeNodeData) {
    if (node.nodeType === 'project' || node.nodeType === 'root-user' || node.nodeType === 'root-projects') return <FolderIcon/>
    if (node.nodeType === 'archive-folder') return <ArchiveIcon/>
    return <FileIcon/>
}

// --- Tree rendering ---

interface TreeRenderProps {
    nodes: TreeNodeData[]
    depth: number
    expandedKeys: Set<string>
    onToggle: (key: string) => void
    selectedKey: string | null
    onSelect: (node: TreeNodeData) => void
    onContextMenu: (e: React.MouseEvent, node: TreeNodeData) => void
}

function renderTreeNodes({nodes, depth, expandedKeys, onToggle, selectedKey, onSelect, onContextMenu}: TreeRenderProps) {
    return nodes.map((node) => {
        const hasChildren = !!node.children && node.children.length > 0
        const expanded = expandedKeys.has(node.key)
        const isFile = !!node.filePath

        return (
            <div key={node.key}>
                <TreeNode
                    label={node.label}
                    depth={depth}
                    icon={nodeIcon(node)}
                    trailing={node.subtitle}
                    selected={selectedKey === node.key}
                    expanded={expanded}
                    hasChildren={hasChildren}
                    onClick={() => (isFile ? onSelect(node) : onToggle(node.key))}
                    onToggle={() => onToggle(node.key)}
                    onContextMenu={(e) => onContextMenu(e, node)}
                />
                {hasChildren && expanded && (
                    <div>
                        {renderTreeNodes({
                            nodes: node.children!,
                            depth: depth + 1,
                            expandedKeys,
                            onToggle,
                            selectedKey,
                            onSelect,
                            onContextMenu,
                        })}
                    </div>
                )}
            </div>
        )
    })
}

// --- Delete warning messages ---

function getDeleteWarning(node: TreeNodeData): string {
    if (node.nodeType === 'project') {
        return `确认删除「${node.label}」的全部记忆？包括项目记忆和所有归档卷。定时任务将在下次运行时从会话中重新沉淀记忆。`
    }
    if (node.filePath?.endsWith('memory.md')) {
        return '定时任务将在下次运行时重新生成此文件。'
    }
    if (node.filePath?.endsWith('preferences.md')) {
        return '用户偏好将在下次沉淀时重建。'
    }
    if (node.nodeType === 'archive-file') {
        return '归档卷删除后不可恢复，沉淀任务不会自动重建。'
    }
    return '确定删除？'
}

/**
 * 从项目节点的任意子孙文件路径提取该项目的 ref/ 目录路径（Ruling 3：渲染层禁用 require('path')）。
 * 文件路径形如 `<hclawDir>/ref/<dir>/memory.md`（分隔符随平台），取「ref/<dir>」段为止的前缀。
 *
 * F-2 修复：按段重组（split 捕获分隔符再 join），不做裸子串匹配——
 * 子串匹配在文件名内含目录名（如 guali-2026-09.md）时会错位截断，导致删除静默失败。
 */
function extractProjectRefDir(node: TreeNodeData): string | null {
    const dir = node.key.replace('project:', '')
    // 递归找任一子孙文件（项目可能只有归档卷，archive-folder 节点自身无 filePath）
    let childFile: string | undefined
    const walk = (nodes: TreeNodeData[]) => {
        for (const c of nodes) {
            if (c.filePath) {
                childFile = c.filePath
                return
            }
            if (c.children) walk(c.children)
        }
    }
    if (node.children) walk(node.children)
    if (!childFile) return null
    // 捕获分隔符的 split：偶数位为段，奇数位为原始分隔符（保留 \\ / 混用）
    const parts = childFile.split(/([\\/]+)/)
    const segments = parts.filter((_, i) => i % 2 === 0)
    const refIdx = segments.lastIndexOf('ref')
    if (refIdx < 0 || segments[refIdx + 1] !== dir) return null
    // 取到 segments[refIdx+1] 为止的全部内容（含其前所有分隔符），丢弃其后的分隔符与文件段
    return parts.slice(0, 2 * (refIdx + 1) + 1).join('')
}

// --- Main Component ---

export default function MemoryManagerDialog() {
    const {
        treeData,
        treeLoadState,
        treeLoadError,
        selectedFile,
        fileContent,
        contentLoadState,
        contentLoadError,
        editMode,
        dirtyContent,
        byteCount,
        overLimit,
        loadTree,
        loadFile,
        setEditMode,
        setDirtyContent,
        saveCurrentFile,
        deleteFile,
    } = useMemoryManagerStore()

    // 展开状态（局部）；默认全折叠（不消费 buildTreeData 的 defaultExpanded），由用户手动/工具栏展开
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

    // 删除结果反馈（F-4/F-6：失败与不可定位目录不得静默）
    const [feedback, setFeedback] = useState<{message: string; type: 'success' | 'error'} | null>(null)
    const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const showFeedback = useCallback((message: string, type: 'success' | 'error') => {
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
        setFeedback({message, type})
        feedbackTimerRef.current = setTimeout(() => setFeedback(null), 3000)
    }, [])
    useEffect(() => () => {
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    }, [])
    useEffect(() => {
        void loadTree()
    }, [loadTree])

    const treeNodes = treeData ? buildTreeData(treeData) : []

    // 关窗结算（F-A，Spec §4.5）：close-request 处理器走 store.getState() 取最新状态，
    // 监听器只注册一次不受闭包过期影响
    const handleWindowCloseRequest = useCallback(async () => {
        const wc = window.electronAPI?.windowControls
        if (!wc?.confirmClose) return
        // 渲染层已响应：先解除主进程 2s 兜底强关（计时器只针对「渲染层无响应」）
        void wc.cancelClose?.()
        const s = useMemoryManagerStore.getState()
        if (s.dirtyContent === null) {
            // 竞态兜底：拦截已武装但内容已被结算（如切换文件后到达）→ 直接放行
            void wc.confirmClose()
            return
        }
        const shouldSave = await confirm({
            title: '未保存的修改',
            message: '当前文件有未保存的修改，关闭前是否保存？',
            confirmText: '保存并关闭',
            cancelText: '不保存',
        })
        if (shouldSave) {
            const saved = await s.saveCurrentFile()
            if (saved) {
                void wc.confirmClose()
                return
            }
            // 保存失败：留在窗口保留内容（不关窗）
            return
        }
        const shouldDiscard = await confirm({
            title: '放弃修改',
            message: '确定放弃未保存的修改并关闭窗口？',
            confirmText: '放弃并关闭',
            cancelText: '取消',
        })
        if (shouldDiscard) {
            s.setDirtyContent(null)
            void wc.confirmClose()
        }
        // 取消：不关窗（兜底计时器已在入口解除）
    }, [])

    // 注册 close-request 监听（一次注册，回调内自取最新状态）
    useEffect(() => {
        const wc = window.electronAPI?.windowControls
        if (!wc?.onCloseRequest) return
        return wc.onCloseRequest(() => { void handleWindowCloseRequest() })
    }, [handleWindowCloseRequest])

    // 按 dirtyContent 动态武装 close 拦截：无未保存修改时 X 直接关窗（不发 close-request）
    useEffect(() => {
        void window.electronAPI?.windowControls?.setCloseIntercept?.(dirtyContent !== null)
        return () => {
            void window.electronAPI?.windowControls?.setCloseIntercept?.(false)
        }
    }, [dirtyContent])

    const handleSelect = useCallback(
        async (node: TreeNodeData) => {
            if (node.filePath) {
                await loadFile(node.filePath, node.label, node.sizeLimit)
            }
        },
        [loadFile],
    )

    const handleDelete = useCallback(
        async (node: TreeNodeData) => {
            if (!node.filePath && node.nodeType !== 'project') return
            const confirmed = await confirm({
                title: '删除确认',
                message: getDeleteWarning(node),
                confirmText: '删除',
                confirmVariant: 'danger',
            })
            if (!confirmed) return
            if (node.nodeType === 'project') {
                // 删除整个项目 ref/<dir> 目录（路径从树节点 filePath 前缀提取，不用 path 模块）
                const projectDir = extractProjectRefDir(node)
                if (!projectDir) {
                    // F-6：空项目 / 无法定位目录时给出提示，不静默
                    showFeedback(node.children?.length ? '无法定位项目记忆目录，未执行删除' : '该项目下没有记忆文件，未执行删除', 'error')
                    return
                }
                const ok = await deleteFile(projectDir, true)
                if (ok) showFeedback(`已删除「${node.label}」的全部记忆`, 'success')
                else showFeedback('删除失败，请检查文件是否被占用', 'error')
            } else if (node.filePath) {
                const ok = await deleteFile(node.filePath, false)
                if (ok) showFeedback(`已删除「${node.label}」`, 'success')
                else showFeedback('删除失败，请检查文件是否被占用', 'error')
            }
        },
        [deleteFile, showFeedback],
    )

    // 编辑 ⇄ 预览切换：预览→编辑直接切；编辑→预览结算未保存修改
    const handleModeSwitch = useCallback(async () => {
        if (editMode) {
            if (dirtyContent !== null) {
                const shouldSave = await confirm({
                    title: '未保存的修改',
                    message: '当前文件有未保存的修改，是否保存？',
                    confirmText: '保存',
                    cancelText: '放弃',
                })
                if (shouldSave) {
                    const saved = await saveCurrentFile()
                    if (!saved) return // 保存失败：留在编辑态保留内容
                } else {
                    setDirtyContent(null)
                }
            }
            setEditMode(false)
        } else {
            setEditMode(true)
        }
    }, [editMode, dirtyContent, saveCurrentFile, setEditMode, setDirtyContent])

    // 树顶部按钮栏：展开/折叠全部可展开目录节点（①需求）
    const handleExpandAll = useCallback(() => {
        const next = new Set<string>()
        const walk = (nodes: TreeNodeData[]) => {
            for (const n of nodes) {
                if (n.children && n.children.length > 0) {
                    next.add(n.key)
                    walk(n.children)
                }
            }
        }
        walk(treeNodes)
        setExpandedKeys(next)
    }, [treeNodes])

    const handleCollapseAll = useCallback(() => {
        setExpandedKeys(new Set())
    }, [])

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-1 min-h-0">
                {/* 左：文件树 */}
                <div className="w-64 shrink-0 border-r border-[var(--border)] overflow-y-auto bg-[var(--surface-muted)]">
                    {treeLoadState === 'loading' && (
                        <div className="p-4 text-sm text-[var(--text-muted)]">加载中...</div>
                    )}
                    {treeLoadState === 'error' && (
                        <div className="p-4">
                            <div className="text-sm text-[var(--text-danger)] mb-2">{treeLoadError || '加载失败'}</div>
                            <button
                                className="text-sm text-[var(--brand-primary)] hover:underline"
                                onClick={() => void loadTree()}
                            >
                                重试
                            </button>
                        </div>
                    )}
                    {treeLoadState === 'loaded' && treeNodes.length === 0 && (
                        <div className="p-4 text-sm text-[var(--text-muted)]">暂无记忆文件，记忆会在会话中自动积累。</div>
                    )}
                    {treeLoadState === 'loaded' && treeNodes.length > 0 && (
                        <>
                        <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-[var(--border)]">
                            <button
                                aria-label="展开全部"
                                className="text-xs px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
                                onClick={handleExpandAll}
                            >
                                展开全部
                            </button>
                            <button
                                aria-label="折叠全部"
                                className="text-xs px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
                                onClick={handleCollapseAll}
                            >
                                折叠全部
                            </button>
                        </div>
                        <div role="tree" className="py-1 text-[var(--text-primary)]">
                            {renderTreeNodes({
                                nodes: treeNodes,
                                depth: 0,
                                expandedKeys,
                                onToggle: (key) =>
                                    setExpandedKeys((prev) => {
                                        const next = new Set(prev)
                                        if (next.has(key)) next.delete(key)
                                        else next.add(key)
                                        return next
                                    }),
                                selectedKey: selectedFile?.path ?? null,
                                onSelect: (node) => void handleSelect(node),
                                onContextMenu: (e, node) => {
                                    e.preventDefault()
                                    void handleDelete(node)
                                },
                            })}
                        </div>
                        </>
                    )}
                </div>

                {/* 右：预览 / 编辑 */}
                <div className="flex-1 min-w-0 flex flex-col">
                    {selectedFile && (
                        <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
                            <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                                {selectedFile.label}
                            </span>
                            <button
                                className="shrink-0 text-sm px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--surface-muted)] text-[var(--text-secondary)]"
                                onClick={() => void handleModeSwitch()}
                            >
                                {editMode ? '预览' : '编辑'}
                            </button>
                        </div>
                    )}

                    <div className="flex-1 min-h-0 overflow-hidden">
                        {!selectedFile && (
                            <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
                                从左侧选择一个记忆文件
                            </div>
                        )}
                        {selectedFile && contentLoadState === 'loading' && (
                            <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">加载中...</div>
                        )}
                        {selectedFile && contentLoadState === 'loaded' && editMode && (
                            <MemoryEditor
                                content={dirtyContent ?? fileContent}
                                fileKey={selectedFile.path}
                                onChange={(val) => setDirtyContent(val)}
                            />
                        )}
                        {selectedFile && contentLoadState === 'loaded' && !editMode && (
                            <div className="h-full overflow-y-auto p-6">
                                <MarkdownPreview content={fileContent} basePath={selectedFile.path}/>
                            </div>
                        )}
                        {selectedFile && contentLoadState === 'error' && (
                            <div className="h-full flex items-center justify-center text-sm text-[var(--text-danger)]">
                                {contentLoadError === 'save-failed' ? '保存失败，修改已保留' : '文件已被删除或无法读取'}
                            </div>
                        )}
                    </div>

                    {/* 状态栏：字节数 + 超限警示 */}
                    {selectedFile && contentLoadState === 'loaded' && (
                        <div className="shrink-0 px-4 py-1.5 border-t border-[var(--border)] flex items-center gap-2 text-xs">
                            <span className={overLimit ? 'text-[var(--text-danger)]' : 'text-[var(--text-muted)]'}>
                                {byteCount} / {selectedFile.sizeLimit > 0 ? selectedFile.sizeLimit : '∞'} bytes
                            </span>
                            {overLimit && (
                                <span className="text-[var(--text-danger)]">超限，沉淀任务将自动压档到 archive/</span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* 删除结果反馈（固定底部居中，配色走语义变量） */}
            {feedback && (
                <div
                    role={feedback.type === 'error' ? 'alert' : 'status'}
                    className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--surface-elevated)] border border-[var(--border)] shadow-elevated text-sm"
                >
                    <span className={feedback.type === 'error' ? 'text-[var(--text-danger)]' : 'text-[var(--text-primary)]'}>
                        {feedback.message}
                    </span>
                </div>
            )}
        </div>
    )
}
