import type {AttachedFile} from './InputArea'

interface AttachedFilesBarProps {
    files: AttachedFile[]
    onRemove: (fileId: string) => void
    onPreview: (previewUrl: string) => void
    onOpenFile: (filePath: string) => void
    onClearAll: () => void
}

/**
 * 附件预览条 — 显示已添加的文件缩略图，支持预览/打开/删除/全部清除
 */
export default function AttachedFilesBar({files, onRemove, onPreview, onOpenFile, onClearAll}: AttachedFilesBarProps) {
    if (files.length === 0) return null

    return (
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface-muted)]/30">
            <div className="flex items-center gap-2 min-h-[48px]">
                {/* 文件列表 */}
                <div className="flex items-center gap-2 flex-1 overflow-x-auto">
                    {files.map((file) => (
                        <div key={file.id} className="relative group shrink-0">
                            <div
                                onClick={() => {
                                    if (file.isImage && file.previewUrl) {
                                        onPreview(file.previewUrl)
                                    } else if (file.path) {
                                        onOpenFile(file.path)
                                    }
                                }}
                                className="cursor-pointer w-10 h-10 rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--brand-primary)] transition-colors"
                                title={file.isImage ? '点击预览图片' : `打开文件: ${file.path || file.name}`}
                            >
                                {file.isImage && file.previewUrl ? (
                                    <img src={file.previewUrl} alt={file.name}
                                         className="w-full h-full object-cover"/>
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <svg className="w-5 h-5 text-[var(--text-muted)]" viewBox="0 0 24 24"
                                             fill="none" stroke="currentColor" strokeWidth="1.5">
                                            <path d="M7 2h8a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zm0 1.5V6h6V3.5M9 10v4m0 4h.01"/>
                                        </svg>
                                    </div>
                                )}
                            </div>
                            {/* 删除按钮 */}
                            <button
                                onClick={() => onRemove(file.id)}
                                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                                title="移除"
                            >
                                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                    <path d="M18 6L6 18M6 6l12 12"/>
                                </svg>
                            </button>
                            {/* 文件名提示 */}
                            <span
                                className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-[var(--text-muted)] whitespace-nowrap truncate max-w-[48px]"
                                title={file.name}>
                                {file.name.length > 6 ? file.name.slice(0, 6) + '...' : file.name}
                            </span>
                        </div>
                    ))}
                </div>
                {/* 清除全部按钮 */}
                {files.length > 1 && (
                    <button
                        onClick={onClearAll}
                        className="shrink-0 px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-red-500 hover:bg-red-50 rounded border border-[var(--border)] transition-colors"
                        title="清除全部附件"
                    >
                        清除全部
                    </button>
                )}
            </div>
        </div>
    )
}
