import {useEffect, useRef, useState} from 'react'
import {usePromptSchemeStore} from '../../stores/promptSchemeStore'
import type {PromptNodeKey, PromptNodeMeta, PromptScheme} from '@shared/types'
import {
    ALL_PROMPT_NODES,
    createDefaultPromptScheme,
} from '@shared/prompts'
import MarkdownRenderer from '../message-list/MarkdownRenderer'

// ─── 子组件: 方案列表项 ───────────────────────────────────

function SchemeListItem({
                            scheme,
                            isActive,
                            isSelected,
                            onSelect,
                            onActivate,
                        }: {
    scheme: PromptScheme
    isActive: boolean
    isSelected: boolean
    onSelect: () => void
    onActivate: () => void
}) {
    return (
        <div
            onClick={onSelect}
            onDoubleClick={onActivate}
            className={`w-full group px-2 py-1.5 rounded transition-colors flex items-center justify-between cursor-pointer ${
                isSelected
                    ? 'bg-brand-50 text-brand-600'
                    : 'text-gray-600 hover:bg-gray-50'
            }`}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                <div
                    className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                        isActive ? 'bg-green-400' : 'bg-gray-300'
                    }`}
                />
                <span className="text-xs truncate">{scheme.name}</span>
            </div>
            {isActive && (
                <span className="shrink-0 text-[10px] text-green-500 font-medium">激活中</span>
            )}
        </div>
    )
}

// ─── 子组件: 删除确认按钮 ─────────────────────────────────

function DeleteConfirmButton({onConfirm}: { onConfirm: () => void }) {
    const [confirming, setConfirming] = useState(false)

    if (confirming) {
        return (
            <div className="flex items-center gap-1">
                <button
                    onClick={onConfirm}
                    className="px-1.5 py-0.5 text-[10px] bg-red-500 text-white rounded hover:bg-red-600"
                >
                    确认
                </button>
                <button
                    onClick={() => setConfirming(false)}
                    className="px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-400 rounded hover:bg-gray-200"
                >
                    取消
                </button>
            </div>
        )
    }

    return (
        <button
            onClick={() => setConfirming(true)}
            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
            title="删除方案"
        >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
        </button>
    )
}

// ─── 主组件: PromptConfigDialog ────────────────────────────

export default function PromptConfigDialog() {
    const {
        schemes,
        activePromptSchemeId,
        addScheme,
        updateScheme,
        removeScheme,
        duplicateScheme,
        setActiveScheme,
        setNode,
        resetNode,
    } = usePromptSchemeStore()

    const [selectedSchemeId, setSelectedSchemeId] = useState<string | null>(activePromptSchemeId)
    const [selectedNodeKey, setSelectedNodeKey] = useState<PromptNodeKey | null>(null)
    const [previewContent, setPreviewContent] = useState<string | null>(null)
    const [isPreviewOpen, setIsPreviewOpen] = useState(false)
    const [isPreviewLoading, setIsPreviewLoading] = useState(false)
    const [copied, setCopied] = useState(false)
    const [sidebarWidth, setSidebarWidth] = useState(160)

    const isResizing = useRef(false)

    // 当前选中的方案
    const selectedScheme = schemes.find(s => s.id === selectedSchemeId) || null

    // 选中节点信息
    const selectedNode = selectedNodeKey
        ? ALL_PROMPT_NODES.find((n: PromptNodeMeta) => n.key === selectedNodeKey)
        : null

    // 当前节点的值（优先从方案覆盖取，否则从默认值取）
    const getNodeValue = (key: PromptNodeKey): string => {
        if (selectedScheme?.nodes?.[key]) {
            return selectedScheme.nodes[key] as string
        }
        const node = ALL_PROMPT_NODES.find((n: PromptNodeMeta) => n.key === key)
        return node?.defaultValue || ''
    }

    // 是否已自定义（比较内容是否与默认值不同，而非仅检查 key 是否存在）
    const isCustomized = (key: PromptNodeKey) => {
        const savedValue = selectedScheme?.nodes?.[key]
        if (!savedValue) return false
        const defaultNode = ALL_PROMPT_NODES.find((n) => n.key === key)
        if (!defaultNode) return true
        return savedValue !== defaultNode.defaultValue
    }

    // 更新节点值
    const updateNodeValue = (key: PromptNodeKey, value: string) => {
        if (!selectedSchemeId) return
        if (value.trim()) {
            setNode(selectedSchemeId, key, value)
        } else {
            resetNode(selectedSchemeId, key)
        }
    }

    // ─── 侧边栏宽度调节 ───────────────────────────────────

    const startResizing = (e: React.MouseEvent) => {
        e.preventDefault()
        isResizing.current = true
        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', stopResizing)
        document.body.style.cursor = 'col-resize'
    }

    const handleMouseMove = (e: MouseEvent) => {
        if (!isResizing.current) return
        const container = document.querySelector('.prompt-scheme-dialog-container')
        if (!container) return
        const rect = container.getBoundingClientRect()
        const newWidth = e.clientX - rect.left
        if (newWidth >= 120 && newWidth <= 300) {
            setSidebarWidth(newWidth)
        }
    }

    const stopResizing = () => {
        isResizing.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', stopResizing)
        document.body.style.cursor = 'default'
    }

    // ─── 预览功能 ─────────────────────────────────────────

    const handlePreview = async () => {
        if (!selectedScheme) return
        setIsPreviewLoading(true)
        try {
            // 构建当前方案的节点数据（含自定义 + 默认值的完整合并）
            const nodes: Record<string, string> = {}
            for (const node of ALL_PROMPT_NODES) {
                nodes[node.key] = getNodeValue(node.key)
            }

            if (typeof window !== 'undefined' && window.electronAPI?.systemPromptBuildWithScheme) {
                const result = await window.electronAPI.systemPromptBuildWithScheme(nodes)
                if (result?.success && result.systemPrompt) {
                    setPreviewContent(result.systemPrompt)
                    setIsPreviewOpen(true)
                } else {
                    setPreviewContent(`构建失败: ${result?.error || '未知错误'}`)
                    setIsPreviewOpen(true)
                }
            } else {
                setPreviewContent('预览功能不可用（IPC 未就绪）')
                setIsPreviewOpen(true)
            }
        } catch (err) {
            setPreviewContent(`预览出错: ${String(err)}`)
            setIsPreviewOpen(true)
        } finally {
            setIsPreviewLoading(false)
        }
    }

    const handleCopy = () => {
        if (previewContent) {
            navigator.clipboard.writeText(previewContent)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        }
    }

    // 确保选中方案变化时同步选中节点
    useEffect(() => {
        setSelectedNodeKey(null)
    }, [selectedSchemeId])

    // 首次打开时，如果尚未选中任何方案，自动选中当前激活的方案
    useEffect(() => {
        if (selectedSchemeId === null && activePromptSchemeId !== null) {
            setSelectedSchemeId(activePromptSchemeId)
        }
    }, [activePromptSchemeId, selectedSchemeId])

    // 首次选中方案时，自动选中第一个节点
    const [hasAutoSelectedNode, setHasAutoSelectedNode] = useState(false)
    useEffect(() => {
        if (selectedScheme && !hasAutoSelectedNode && ALL_PROMPT_NODES.length > 0) {
            setSelectedNodeKey(ALL_PROMPT_NODES[0].key)
            setHasAutoSelectedNode(true)
        }
    }, [selectedScheme, hasAutoSelectedNode])

    // 方案变化时重置自动选中状态
    useEffect(() => {
        setHasAutoSelectedNode(false)
    }, [selectedSchemeId])

    return (
        <div className="flex h-full min-h-[400px] prompt-scheme-dialog-container">
            {/* ─── 左侧：方案列表 ───────────────────────────── */}
            <div
                style={{width: sidebarWidth}}
                className="shrink-0 border-r border-gray-100 flex flex-col relative"
            >
                <div className="px-3 py-2 border-b border-gray-100">
                    <h4 className="text-xs font-medium text-gray-600">方案列表</h4>
                </div>
                <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
                    {schemes.length === 0 ? (
                        <div className="px-2 py-3 text-[10px] text-gray-300 text-center">
                            暂无方案
                        </div>
                    ) : (
                        schemes.map((scheme) => (
                            <SchemeListItem
                                key={scheme.id}
                                scheme={scheme}
                                isActive={scheme.id === activePromptSchemeId}
                                isSelected={scheme.id === selectedSchemeId}
                                onSelect={() => {
                                    setSelectedSchemeId(scheme.id)
                                }}
                                onActivate={() => setActiveScheme(scheme.id)}
                            />
                        ))
                    )}
                </div>
                <div className="p-2 border-t border-gray-100 space-y-1">
                    <button
                        onClick={() => {
                            const defaultScheme = createDefaultPromptScheme('新方案')
                            const id = addScheme(defaultScheme)
                            setSelectedSchemeId(id)
                        }}
                        className="w-full px-2 py-1.5 text-xs text-brand-500 hover:bg-brand-50 rounded transition-colors"
                    >
                        + 新建方案
                    </button>
                    <button
                        onClick={() => {
                            const id = addScheme(createDefaultPromptScheme('默认方案'))
                            setSelectedSchemeId(id)
                        }}
                        className="w-full px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-50 rounded transition-colors"
                    >
                        从默认创建
                    </button>
                </div>

                {/* 拖拽调节宽度手柄 */}
                <div
                    onMouseDown={startResizing}
                    className="absolute -right-0.5 top-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/30 transition-colors z-10"
                />
            </div>

            {/* ─── 右侧：方案编辑 ───────────────────────────── */}
            <div className="flex-1 flex flex-col">
                {selectedScheme ? (
                    <>
                        {/* 方案头部 */}
                        <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
                            <div className="flex items-center gap-2">
                                <h4 className="text-sm font-medium text-gray-700">
                                    {selectedScheme.name}
                                </h4>
                                {selectedScheme.id === activePromptSchemeId && (
                                    <span
                                        className="text-[10px] bg-green-100 text-green-600 px-1.5 py-0.5 rounded font-medium">
                                        激活中
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => {
                                        duplicateScheme(selectedScheme.id)
                                    }}
                                    className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                    title="克隆此方案"
                                >
                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"
                                         stroke="currentColor" strokeWidth="2">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                    </svg>
                                </button>
                                <DeleteConfirmButton
                                    onConfirm={() => {
                                        removeScheme(selectedScheme.id)
                                        setSelectedSchemeId(schemes[0]?.id || null)
                                    }}
                                />
                            </div>
                        </div>

                        <div className="flex-1 flex overflow-hidden">
                            {/* 节点列表 */}
                            <div className="w-44 border-r border-gray-100 flex flex-col shrink-0 bg-white">
                                <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
                                    {ALL_PROMPT_NODES.map((node: PromptNodeMeta) => (
                                        <button
                                            key={node.key}
                                            onClick={() => setSelectedNodeKey(node.key)}
                                            className={`w-full px-2 py-1.5 text-left rounded text-xs transition-colors ${
                                                selectedNodeKey === node.key
                                                    ? 'bg-brand-50 text-brand-600'
                                                    : 'text-gray-600 hover:bg-gray-50'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="truncate">{node.name}</span>
                                                {isCustomized(node.key) && (
                                                    <span className="text-[10px] text-brand-400 font-medium">✎</span>
                                                )}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* 编辑器 */}
                            <div className="flex-1 flex flex-col bg-gray-50/30">
                                {selectedNode ? (
                                    <div className="flex-1 flex flex-col p-4 overflow-hidden">
                                        <div className="mb-3">
                                            <div className="flex items-center justify-between mb-1">
                                                <h5 className="text-sm font-semibold text-gray-700">
                                                    {selectedNode.name}
                                                </h5>
                                                {isCustomized(selectedNode.key) && (
                                                    <button
                                                        onClick={() => resetNode(selectedSchemeId!, selectedNodeKey!)}
                                                        className="text-[10px] text-brand-500 hover:underline"
                                                    >
                                                        恢复默认
                                                    </button>
                                                )}
                                            </div>
                                            <p className="text-[11px] text-gray-400 leading-relaxed">
                                                {selectedNode.description}
                                            </p>
                                        </div>

                                        <div
                                            className="flex-1 flex flex-col min-h-0 bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
                                            <div
                                                className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tight">
                          {isCustomized(selectedNode.key) ? '✍️ 已修改内容' : '📄 默认内容 (只读)'}
                        </span>
                                                {!isCustomized(selectedNode.key) && (
                                                    <span className="text-[10px] text-amber-500 italic">
                          修改下方文本以启用自定义
                        </span>
                                                )}
                                            </div>
                                            <textarea
                                                value={getNodeValue(selectedNodeKey!)}
                                                onChange={(e) => {
                                                    updateNodeValue(selectedNodeKey!, e.target.value)
                                                }}
                                                placeholder="在此输入自定义提示词内容..."
                                                className="flex-1 w-full p-3 text-xs text-gray-700 font-mono resize-none outline-none leading-relaxed"
                                            />
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex items-center justify-center text-xs text-gray-300">
                                        请选择左侧节点进行编辑
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* 底部操作栏 */}
                        <div
                            className="px-4 py-2 border-t border-gray-100 flex items-center justify-end gap-2 shrink-0">
                            <button
                                onClick={handlePreview}
                                disabled={isPreviewLoading}
                                className="px-3 py-1 text-xs text-gray-500 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
                            >
                                {isPreviewLoading ? '构建中...' : '预览系统提示词'}
                            </button>

                            {selectedScheme.id !== activePromptSchemeId && (
                                <button
                                    onClick={() => setActiveScheme(selectedScheme.id)}
                                    className="px-3 py-1 text-xs bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors"
                                >
                                    激活方案
                                </button>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-xs text-gray-300 gap-2">
                        <span>请选择或创建一个方案</span>
                        {activePromptSchemeId === null && schemes.length === 0 && (
                            <span className="text-[10px] text-gray-200">
                                当前使用代码默认提示词（无激活方案）
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* ─── 预览弹窗 ───────────────────────────────── */}
            {isPreviewOpen && previewContent !== null && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
                    onClick={() => setIsPreviewOpen(false)}
                >
                    <div
                        className="bg-white rounded-xl shadow-2xl w-[700px] max-w-[90vw] max-h-[80vh] flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                            <h4 className="text-sm font-medium text-gray-700">系统提示词预览</h4>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleCopy}
                                    className="px-2 py-1 text-[10px] text-gray-500 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
                                >
                                    {copied ? '已复制' : '复制'}
                                </button>
                                <button
                                    onClick={() => setIsPreviewOpen(false)}
                                    className="p-1 text-gray-400 hover:text-gray-600"
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none"
                                         stroke="currentColor" strokeWidth="2">
                                        <line x1="18" y1="6" x2="6" y2="18"/>
                                        <line x1="6" y1="6" x2="18" y2="18"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-auto p-4 text-xs">
                            <MarkdownRenderer isUser={false} theme="dark">
                                {previewContent}
                            </MarkdownRenderer>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
