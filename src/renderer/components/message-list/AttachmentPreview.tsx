/**
 * 附件预览组件
 */

import {memo, useCallback, useEffect, useState} from 'react'
import type {Attachment} from '@shared/types'
import {formatSize, getFileTypeConfig} from './utils/fileTypes'
import ImagePreviewModal from '../common/ImagePreviewModal'

interface AttachmentPreviewProps {
    attachments: Attachment[]
}

/**
 * 附件预览容器组件
 */
const AttachmentPreview = memo(function AttachmentPreview({attachments}: AttachmentPreviewProps) {
    return (
        <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((att) => (
                <div key={att.id} className="group relative">
                    {isImage(att) ? (
                        <ImagePreviewCard att={att}/>
                    ) : (
                        <FileTypeCard att={att}/>
                    )}
                </div>
            ))}
        </div>
    )
})

/**
 * 判断是否为图片
 */
function isImage(att: Attachment): boolean {
    if (att.isImage) return true
    return att.type?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(att.name)
}

/**
 * 图片预览卡片组件
 */
const ImagePreviewCard = memo(function ImagePreviewCard({att}: { att: Attachment }) {
    const [dataUrl, setDataUrl] = useState<string | null>(null)
    const [showModal, setShowModal] = useState(false)
    const config = getFileTypeConfig(att.name)
    const path = att.path

    // 消息附件使用 filePath 通过 IPC 加载 data URL
    // 注意：不使用 previewUrl（blob URL），因为它是临时的，
    // 消息持久化后已失效，且可能在 React 重渲染时被回收
    useEffect(() => {
        if (!path) {
            setDataUrl(null);
            return
        }
        let cancelled = false
        window.electronAPI?.readFileAsDataUrl?.(path).then((url) => {
            if (!cancelled) setDataUrl(url || null)
        }).catch(() => {
            if (!cancelled) setDataUrl(null)
        })
        return () => {
            cancelled = true
        }
    }, [path])

    const hasImage = !!dataUrl

    return (
        <>
            <div
                className={`relative rounded-lg overflow-hidden border border-[var(--border)]/30 ${
                    !hasImage ? config.bgColor : 'bg-black/10'
                } ${hasImage ? 'cursor-pointer' : ''}`}
                onClick={hasImage ? () => setShowModal(true) : undefined}
            >
                {hasImage ? (
                    <img src={dataUrl!} alt={att.name}
                         className="max-w-[200px] max-h-[150px] object-cover"
                         onError={() => setDataUrl(null)}/>
                ) : (
                    <div className="w-[200px] h-[150px] flex items-center justify-center">
                        <span className={`text-5xl font-bold ${config.textColor}`}>{config.letter}</span>
                    </div>
                )}
                <div
                    className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <p className="text-white text-[8px] truncate font-medium">{att.name}</p>
                    {att.size > 0 && <p className="text-white/70 text-[7px]">{formatSize(att.size)}</p>}
                </div>
                {hasImage && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/20 transition-colors">
                        <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                            </svg>
                        </div>
                    </div>
                )}
            </div>

            {showModal && dataUrl && (
                <ImagePreviewModal src={dataUrl!} alt={att.name} onClose={() => setShowModal(false)}/>
            )}
        </>
    )
})

/**
 * 文件类型卡片组件（非图片文件）
 */
const FileTypeCard = memo(function FileTypeCard({att}: { att: Attachment }) {
    const config = getFileTypeConfig(att.name)

    const handleOpenFile = useCallback(async () => {
        if (att.path) {
            await window.electronAPI?.openPath(att.path)
        }
    }, [att.path])

    return (
        <div
            onClick={handleOpenFile}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg ${config.bgColor} border border-[var(--border)]/30 cursor-pointer hover:border-[var(--border)]/50 transition-colors`}
            title={`打开文件: ${att.path || att.name}`}
        >
            {/* 首字母 */}
            <span className={`text-sm font-bold ${config.textColor}`}>{config.letter}</span>
            <div className="flex flex-col">
                <span className="text-[var(--text-primary)] text-xs font-medium truncate max-w-[120px]">
                    {att.name}
                </span>
                {att.size > 0 && <span className="text-[var(--text-muted)] text-[10px]">{formatSize(att.size)}</span>}
            </div>
        </div>
    )
})

export default AttachmentPreview
