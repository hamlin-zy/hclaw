/**
 * MemoEditDialog - 备忘录新增/编辑独立窗口（修订 2 Task B）
 *
 * 独立渲染进程，zustand store 不共享：数据全部经 window.electronAPI.memo IPC 读写。
 * 打开参数（openConfigWindow extraArgs，preload 解析为 memoId / memoWorkspace）：
 * - --hclaw-memo-id=<id>        编辑态：memo:getById 回填表单
 * - --hclaw-memo-workspace=<p>  新建态：memo:create 作用于该工作区
 *
 * 附件上传：渲染层读 file.arrayBuffer() → saveTempFile 落盘 → memo:uploadAttachment
 * （参考 InputArea；不把 File 传给 IPC——剪贴板 File 无磁盘路径且跨 bridge 会报 clone 错误）。
 * 无 memoId 时先暂存 _pending；保存时 create/update 会将暂存迁移到正式归档目录，
 * 取消/放弃时对本次新增的暂存附件调用 discardPending 清理。
 * 保存成功后仅关闭本窗口：memo_changed 广播会驱动主窗口自动刷新。
 */
import React, {useEffect, useRef, useState} from 'react'
import CapabilityPicker from '../common/CapabilityPicker'
import type {MemoItem, MemoCapability, MemoAttachment} from '@shared/types/memo'
import {toMediaUrl, isImageFileName} from '@/renderer/utils/mediaUrl'

const MAX_ATTACHMENTS = 20

export default function MemoEditDialog() {
    const memoId = window.electronAPI?.memoId ?? ''
    const workspacePath = window.electronAPI?.memoWorkspace ?? ''
    const isEdit = Boolean(memoId)

    const [title, setTitle] = useState('')
    const [content, setContent] = useState('')
    const [capability, setCapability] = useState<MemoCapability | undefined>(undefined)
    const [attachments, setAttachments] = useState<MemoAttachment[]>([])
    const [loading, setLoading] = useState(isEdit)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [status, setStatus] = useState<'active' | 'processed'>('active')
    const [tip, setTip] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [dragOver, setDragOver] = useState(false)
    const fileRef = useRef<HTMLInputElement>(null)
    // 本次会话新上传（暂存于 _pending）的附件 id：取消/放弃时需清理
    const addedPendingIds = useRef<string[]>([])

    useEffect(() => {
        if (!isEdit) return
        let cancelled = false
        void (async () => {
            const res = await window.electronAPI?.memo.getById(memoId)
            if (cancelled) return
            if (res?.ok && res.data) {
                const item = res.data as MemoItem
                setTitle(item.title)
                setContent(item.content)
                setCapability(item.capability)
                setAttachments(item.attachments)
                setStatus(item.status)
            } else {
                setLoadError(res?.error || '备忘录不存在')
            }
            setLoading(false)
        })()
        return () => {
            cancelled = true
        }
    }, [isEdit, memoId])

    // 参考 InputArea：不把 File 传给 IPC（剪贴板 File 无磁盘路径且跨 bridge 会报 clone 错误），
    // 先读 buffer 落盘到 temp，再用真实路径走 uploadAttachment。
    // 返回 null 表示失败（reason 为首个错误信息或 null）。
    const uploadFile = async (file: File): Promise<{att: MemoAttachment} | {reason: string | null}> => {
        try {
            const buffer = Array.from(new Uint8Array(await file.arrayBuffer()))
            const tempPath = await window.electronAPI?.saveTempFile({buffer, name: file.name})
            if (!tempPath) return {reason: null}
            const res = await window.electronAPI?.memo.uploadAttachment({fileName: file.name, srcPath: tempPath, mime: file.type})
            if (res?.ok && res.data) return {att: res.data as MemoAttachment}
            return {reason: res?.error || null}
        } catch {
            return {reason: null}
        }
    }

    const addFiles = async (files: FileList | File[] | null) => {
        if (!files?.length) return
        const list = Array.from(files)
        if (attachments.length + list.length > MAX_ATTACHMENTS) {
            setTip(`最多 ${MAX_ATTACHMENTS} 个附件`)
            return
        }
        // 新操作开始时清空旧 tip，避免残留误导
        setTip(null)
        const failedNames: string[] = []
        let firstError: string | null = null
        for (const file of list) {
            const result = await uploadFile(file)
            if ('att' in result) {
                addedPendingIds.current.push(result.att.id)
                setAttachments((prev) => [...prev, result.att])
            } else {
                failedNames.push(file.name)
                firstError ??= result.reason
            }
        }
        if (failedNames.length > 0) {
            const reason = failedNames.length === list.length ? (firstError ?? '附件上传失败') : '部分附件上传失败'
            setTip(`${failedNames.join('、')} ${reason}`)
        }
    }

    const removeAttachment = (id: string) => {
        setAttachments((prev) => prev.filter((a) => a.id !== id))
        // 未保存过的暂存附件立即清理该单条，避免依赖取消时兜底
        if (addedPendingIds.current.includes(id)) {
            addedPendingIds.current = addedPendingIds.current.filter((x) => x !== id)
            const api = window.electronAPI?.memo
            if (api) {
                void api.discardPending([id]).catch((err: unknown) => {
                    console.error('memo.discardPending 清理暂存附件失败:', err)
                })
            }
        }
    }

    /** 重新打开：processed → active，成功后刷新本窗数据（memo_changed 广播会同步主窗口列表） */
    const handleReopen = async () => {
        const res = await window.electronAPI?.memo.update(memoId, {status: 'active'})
        if (res?.ok) {
            const fresh = await window.electronAPI?.memo.getById(memoId)
            if (fresh?.ok && fresh.data) setStatus((fresh.data as MemoItem).status)
        } else {
            setTip(res?.error || '重新打开失败')
        }
    }

    /** 拖拽上传：复用 addFiles，preventDefault 防浏览器直接打开文件 */
    const onDrop = (e: React.DragEvent) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
    }
    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault()
        setDragOver(true)
    }

    /** 清理本次新增的暂存附件并关闭窗口 */
    const discardAndClose = async () => {
        const ids = addedPendingIds.current
        addedPendingIds.current = []
        if (ids.length > 0) {
            try {
                await window.electronAPI?.memo.discardPending(ids)
            } catch (err) {
                console.error('memo.discardPending 清理暂存附件失败:', err)
            }
        }
        window.electronAPI?.closeWindow()
    }

    const handleSave = async () => {
        if (saving) return
        if (!title.trim()) {
            setTip('标题不能为空')
            return
        }
        if (!content.trim() && attachments.length === 0) {
            setTip('正文和附件不能同时为空，请至少填写一项')
            return
        }
        setSaving(true)
        const api = window.electronAPI?.memo
        const res = isEdit
            ? await api?.update(memoId, {title: title.trim(), content: content.trim(), capability, attachments})
            : await api?.create({workspacePath, title: title.trim(), content: content.trim(), capability, attachments})
        setSaving(false)
        if (res?.ok) {
            addedPendingIds.current = []
            window.electronAPI?.closeWindow()
        } else {
            setTip(res?.error || '保存失败')
        }
    }

    /** 单个附件卡片：图片显示预览缩略图，非图片显示 📎 文件名 chip（修订 2 Task D）。
     *  暂存附件（storedPath === 'pending'）尚未落盘、toMediaUrl 会 404 破图，
     *  统一降级为 📎 文件名 chip（避免 objectURL 的 revoke/内存泄漏负担）。 */
    const renderAttachmentCard = (a: MemoAttachment) => {
        const isImage = (a.kind === 'image' || isImageFileName(a.fileName)) && a.storedPath !== 'pending'
        return (
            <div
                key={a.id}
                data-testid="memo-attachment-card"
                className="relative inline-flex items-center rounded border border-[var(--border)] bg-[var(--surface-muted)] overflow-hidden"
            >
                {isImage ? (
                    <div className="flex flex-col items-center">
                        <img
                            src={toMediaUrl(a.storedPath)}
                            alt={a.fileName}
                            data-testid="memo-attachment-image"
                            className="w-20 h-20 object-cover"
                        />
                        <span className="max-w-20 px-1 py-0.5 text-[10px] text-[var(--text-muted)] truncate" title={a.fileName}>{a.fileName}</span>
                    </div>
                ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-1 max-w-40 text-[10px] text-[var(--text-muted)]">
                        📎 <span className="truncate" title={a.fileName}>{a.fileName}</span>
                    </span>
                )}
                <button
                    title="移除附件"
                    data-testid={`memo-attachment-remove-${a.id}`}
                    onClick={() => removeAttachment(a.id)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 leading-none rounded-full text-[10px] bg-[var(--surface-overlay)] text-[var(--text-muted)] hover:text-red-500"
                 data-name="memo-edit-dialog-button">×</button>
            </div>
        )
    }

    if (loading) {
        return <div className="p-4 text-sm text-[var(--text-muted)]">加载中...</div>
    }
    if (loadError) {
        return (
            <div className="p-4 space-y-3">
                <div className="text-sm text-red-500">{loadError}</div>
                <button
                    onClick={() => window.electronAPI?.closeWindow()}
                    className="px-3 py-1.5 text-xs rounded bg-[var(--surface-muted)] border border-[var(--border)] hover:bg-[var(--surface-hover)]"
                 data-name="memo-edit-dialog-close-window-button">
                    关闭
                </button>
            </div>
        )
    }

    return (
        <div
            className={`flex flex-col h-full text-[var(--text-primary)] ${dragOver ? 'outline outline-1 outline-[var(--border-emphasis)]' : ''}`}
            data-testid="memo-edit-dialog"
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={() => setDragOver(false)}
        >
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                <div>
                    <label className="block text-xs text-[var(--text-muted)] mb-1">标题</label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="备忘录标题"
                        autoFocus
                        className="w-full px-2 py-1.5 text-sm bg-[var(--surface-muted)] rounded border border-[var(--border)] focus:outline-none focus:border-[var(--border-emphasis)] placeholder-[var(--text-muted)]"
                    data-name="memo-edit-dialog-input"/>
                </div>
                {/* 附件缩略图区：位于标题与正文之间（修订 2 Task D） */}
                {attachments.length > 0 && (
                    <div data-testid="memo-attachment-area" className="flex flex-wrap gap-2">
                        {attachments.map(renderAttachmentCard)}
                    </div>
                )}
                <div>
                    <label className="block text-xs text-[var(--text-muted)] mb-1">正文</label>
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        onPaste={(e) => {
                            if (e.clipboardData?.files?.length) {
                                e.preventDefault()
                                void addFiles(e.clipboardData.files)
                            }
                        }}
                        placeholder="记录备忘..."
                        rows={8}
                        className="w-full px-2 py-1.5 text-xs bg-[var(--surface-muted)] rounded border border-[var(--border)] focus:outline-none focus:border-[var(--border-emphasis)] resize-y placeholder-[var(--text-muted)]"
                    data-name="memo-edit-dialog-textarea"/>
                </div>
                {/* 添加附件：正文下方、能力选择上方（修订 2 Task D）。
                    注意 hidden input 不能用 display:none（Electron 沙箱窗口下原生文件选择器可能静默失败），
                    改用 sr-only 视觉隐藏但保留在布局中。 */}
                <div className="flex items-center gap-2">
                    <button
                        title="添加附件"
                        data-testid="memo-add-attachment"
                        onClick={() => fileRef.current?.click()}
                        className="px-2 py-1 rounded text-xs border border-dashed border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:border-[var(--border-emphasis)]"
                     data-name="memo-edit-dialog-add-attachment-button">
                        + 添加附件
                    </button>
                    <input
                        ref={fileRef}
                        type="file"
                        multiple
                        className="sr-only"
                        aria-label="选择附件文件"
                        onChange={(e) => {
                            void addFiles(e.target.files)
                            e.target.value = ''
                        }}
                    data-name="memo-edit-dialog-attachment-input"/>
                </div>
                <CapabilityPicker
                    selected={capability?.name ?? ''}
                    onSelect={(name, type) => {
                        setCapability(name && name !== capability?.name ? {name, type: type as MemoCapability['type']} : undefined)
                    }}
                />
                {tip && <div className="text-xs text-red-500">{tip}</div>}
            </div>
            {/* 底部操作栏 */}
            <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
                <button
                    onClick={() => void discardAndClose()}
                    className="px-3 py-1.5 text-xs rounded bg-[var(--surface-muted)] border border-[var(--border)] hover:bg-[var(--surface-hover)]"
                 data-name="memo-edit-dialog-discard-button">
                    取消
                </button>
                {isEdit && status === 'processed' && (
                    <button
                        data-testid="memo-reopen"
                        onClick={() => void handleReopen()}
                        className="px-3 py-1.5 text-xs rounded bg-[var(--surface-muted)] border border-[var(--border)] hover:bg-[var(--surface-hover)]"
                     data-name="memo-edit-dialog-reopen-button">
                        重新打开
                    </button>
                )}
                <button
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="px-4 py-1.5 text-xs rounded bg-[var(--brand-primary)] text-white hover:opacity-90 disabled:opacity-50"
                 data-name="memo-edit-dialog-save-button">
                    保存
                </button>
            </div>
        </div>
    )
}
