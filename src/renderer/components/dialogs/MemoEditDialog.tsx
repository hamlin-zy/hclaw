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
import ImagePreviewModal from '../common/ImagePreviewModal'
import {PrioritySelect} from '../common/PrioritySelect'
import {AttachmentIcon} from '../icons'
import type {MemoItem, MemoCapability, MemoAttachment, MemoPriority} from '@shared/types/memo'
import type {ProjectGroupWithMembers} from '@shared/types/projectGroup'
import {toMediaUrl, isImageFileName} from '@/renderer/utils/mediaUrl'
import {workspacePathKey} from '../../lib/workspacePath'
import {getBasename} from '../../lib/format'
import {INPUT_FOCUS} from '../../lib/inputFocus'

const MAX_ATTACHMENTS = 20

/** 工作区记录（workspace:list 返回项；仅取路径与展示名） */
type WorkspaceRecord = {id: string; path: string; name: string; createdAt: number; updatedAt: number}

export default function MemoEditDialog() {
    const memoId = window.electronAPI?.memoId ?? ''
    const workspacePath = window.electronAPI?.memoWorkspace ?? ''
    const isEdit = Boolean(memoId)

    const [title, setTitle] = useState('')
    const [content, setContent] = useState('')
    const [capability, setCapability] = useState<MemoCapability | undefined>(undefined)
    const [priority, setPriority] = useState<MemoPriority>('normal')
    const [attachments, setAttachments] = useState<MemoAttachment[]>([])
    const [loading, setLoading] = useState(isEdit)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [status, setStatus] = useState<'active' | 'processed'>('active')
    const [tip, setTip] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [dragOver, setDragOver] = useState(false)
    /** 大图预览目标：图片附件缩略图点击后置位，复用统一看图组件 ImagePreviewModal */
    const [preview, setPreview] = useState<{src: string; alt: string} | null>(null)
    // ── Task 19：项目组 + 项目 级联字段 ──
    // 独立窗口不共享主窗口 store，故自行拉取 project-group:list / workspace:list（spec §8.3）
    const [groups, setGroups] = useState<ProjectGroupWithMembers[]>([])
    const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
    const [cascadeReady, setCascadeReady] = useState(false)
    /** 级联数据降级提示（R-BV：任一 IPC 失败只降级提示，不抛错、不白屏） */
    const [cascadeTip, setCascadeTip] = useState<string | null>(null)
    /** 默认值待解析的项目路径：新建 = 注入的 memoWorkspace；编辑 = 回填条目的 workspacePath */
    const [targetPath, setTargetPath] = useState(isEdit ? '' : workspacePath)
    /** '' = 未分组（顶层项目） */
    const [projectGroupId, setProjectGroupId] = useState('')
    /** 新建态：默认 = 注入的 memoWorkspace（组信息待级联数据到位后解析） */
    const [projectPath, setProjectPath] = useState(isEdit ? '' : workspacePath)
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
                setPriority(item.priority ?? 'normal')
                setAttachments(item.attachments)
                setStatus(item.status)
                // 项目字段只读展示（跨项目迁移本期不做，§12）：以条目自身 workspacePath 为准
                setProjectPath(item.workspacePath)
                setTargetPath(item.workspacePath)
            } else {
                setLoadError(res?.error || '备忘录不存在')
            }
            setLoading(false)
        })()
        return () => {
            cancelled = true
        }
    }, [isEdit, memoId])

    // ── 级联数据：组列表 + 项目列表（R-BV：任一失败只降级提示，不抛错）──
    useEffect(() => {
        let cancelled = false
        void (async () => {
            const [g, w] = await Promise.all([
                (async () => {
                    try { return await window.electronAPI?.projectGroup?.list?.() } catch { return null }
                })(),
                (async () => {
                    try { return await window.electronAPI?.workspace?.list?.() } catch { return null }
                })(),
            ])
            if (cancelled) return
            const groupList = Array.isArray(g) ? (g as ProjectGroupWithMembers[]) : null
            const wsList = Array.isArray(w) ? (w as WorkspaceRecord[]) : null
            if (groupList) setGroups(groupList)
            if (wsList) setWorkspaces(wsList)
            // 两者都不可用 → 空列表 + tip 提示（不白屏、不抛异常）
            if (!groupList && !wsList) setCascadeTip('项目组/项目列表加载失败，请稍后重试')
            setCascadeReady(true)
        })()
        return () => {
            cancelled = true
        }
    }, [])

    // 默认值解析：注入/回填的 targetPath 所属（组 + 项目）；不属于任何组 → 未分组。
    // ★ 只解析一次，且**用户已手动改过任一字段就不再解析**——级联数据是异步到的，
    //   解析 effect 可能晚于用户操作执行，否则会把用户刚选的值重置回默认值。
    const defaultsAppliedRef = useRef(false)
    const cascadeTouchedRef = useRef(false)
    useEffect(() => {
        if (defaultsAppliedRef.current || cascadeTouchedRef.current) return
        if (!cascadeReady || !targetPath) return
        defaultsAppliedRef.current = true
        const key = workspacePathKey(targetPath)
        const owner = groups.find((gr) => gr.members.some((m) => workspacePathKey(m.projectPath) === key))
        setProjectGroupId(owner?.id ?? '')
        setProjectPath(targetPath)
    }, [cascadeReady, groups, targetPath])

    /** 未被任何组包含的路径 = 顶层项目（R-BV：组数据不可用时全部视为顶层） */
    const groupedKeys = new Set(groups.flatMap((gr) => gr.members.map((m) => workspacePathKey(m.projectPath))))
    /** 当前组下拉对应可选的项目路径（未分组 → 顶层项目；选中组 → 该组成员） */
    const pathsForGroup = (groupId: string): string[] => {
        if (groupId) {
            const gr = groups.find((x) => x.id === groupId)
            return (gr?.members ?? []).map((m) => m.projectPath)
        }
        return workspaces.filter((w) => !groupedKeys.has(workspacePathKey(w.path))).map((w) => w.path)
    }
    const projectOptions = (() => {
        const paths = pathsForGroup(projectGroupId)
        // 默认值来自注入路径（可能尚未在列表中，如 workspace:list 不可用）→ 保底补一项，
        // 否则 select 会显示为「未选择」而 state 却是该路径，造成显示与提交不一致。
        const key = projectPath ? workspacePathKey(projectPath) : ''
        if (key && !paths.some((p) => workspacePathKey(p) === key)) return [projectPath, ...paths]
        return paths
    })()

    const projectLabel = (p: string) => workspaces.find((w) => workspacePathKey(w.path) === workspacePathKey(p))?.name || getBasename(p)
    /** 编辑态只读展示的组名（级联数据不可用时降级为「未分组」） */
    const groupName = groups.find((g) => g.id === projectGroupId)?.name ?? '未分组'

    /** 切换组 → 原项目不在新组内则清空重选（不自动猜） */
    const handleGroupChange = (nextGroupId: string) => {
        cascadeTouchedRef.current = true
        setProjectGroupId(nextGroupId)
        const key = projectPath ? workspacePathKey(projectPath) : ''
        if (key && !pathsForGroup(nextGroupId).some((p) => workspacePathKey(p) === key)) setProjectPath('')
    }

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
        // 两项必填（项目组 + 项目）：未选项目 → 提示且不发起 IPC
        if (!isEdit && !projectPath) {
            setTip('请选择项目')
            return
        }
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
            ? await api?.update(memoId, {title: title.trim(), content: content.trim(), capability, attachments, priority})
            : await api?.create({workspacePath: projectPath, title: title.trim(), content: content.trim(), capability, attachments, priority})
        setSaving(false)
        if (res?.ok) {
            addedPendingIds.current = []
            window.electronAPI?.closeWindow()
        } else {
            setTip(res?.error || '保存失败')
        }
    }

    /** 单个附件卡片：图片显示预览缩略图，非图片显示 附件图标+文件名 chip（修订 2 Task D）。
     *  暂存附件（storedPath === 'pending'）尚未落盘、toMediaUrl 会 404 破图，
     *  统一降级为 附件图标+文件名 chip（避免 objectURL 的 revoke/内存泄漏负担）。 */
    const renderAttachmentCard = (a: MemoAttachment) => {
        const isImage = (a.kind === 'image' || isImageFileName(a.fileName)) && a.storedPath !== 'pending'
        return (
            <div
                key={a.id}
                data-testid="memo-attachment-card"
                className={`relative inline-flex items-center rounded border border-[var(--border)] bg-[var(--surface-muted)] overflow-hidden${
                    isImage ? ' cursor-pointer hover:border-[var(--border-emphasis)]' : ''
                }`}
                onClick={isImage ? () => setPreview({src: toMediaUrl(a.storedPath), alt: a.fileName}) : undefined}
                title={isImage ? '点击预览大图' : undefined}
            >
                {isImage ? (
                    <div className="flex flex-col items-center">
                        <img
                            src={toMediaUrl(a.storedPath)}
                            alt={a.fileName}
                            data-testid="memo-attachment-image"
                            className="w-20 h-20 object-cover"
                        />
                        <span className="max-w-20 px-1 py-0.5 text-[10px] text-[var(--text-secondary)] truncate" title={a.fileName}>{a.fileName}</span>
                    </div>
                ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-1 max-w-40 text-[10px] text-[var(--text-muted)]">
                        <AttachmentIcon className="w-3 h-3 shrink-0"/> <span className="truncate" title={a.fileName}>{a.fileName}</span>
                    </span>
                )}
                <button
                    title="移除附件"
                    data-testid={`memo-attachment-remove-${a.id}`}
                    onClick={(e) => {
                        // 阻断冒泡：否则移除会同时触发卡片的大图预览
                        e.stopPropagation()
                        removeAttachment(a.id)
                    }}
                    className="absolute top-0.5 right-0.5 w-4 h-4 leading-none rounded-full text-[10px] bg-[var(--surface-overlay)] text-[var(--text-muted)] hover:text-[var(--error)]"
                 data-name="memo-edit-dialog-button">×</button>
            </div>
        )
    }

    if (loading) {
        return <div className="p-4 text-sm text-[var(--text-secondary)]">加载中...</div>
    }
    if (loadError) {
        return (
            <div className="p-4 space-y-3">
                <div className="text-sm text-[var(--error)]">{loadError}</div>
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
                    <div className="flex items-center justify-between mb-1">
                        <label className="block text-xs text-[var(--text-secondary)]">标题</label>
                        <PrioritySelect size="md" value={priority} onChange={setPriority}/>
                    </div>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="备忘录标题"
                        autoFocus
                        className={`w-full px-2 py-1.5 text-sm bg-[var(--surface-muted)] rounded border border-[var(--border)] placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
                    data-name="memo-edit-dialog-input"/>
                </div>
                {/* 项目组 + 项目（Task 19，§15.1②/§15.1③）：创建态级联可改；
                    编辑态项目只读（跨项目迁移本期不做，§12），组字段同为文本展示 */}
                {isEdit ? (
                    <div className="space-y-1">
                        <div className="flex text-sm">
                            <span className="w-14 shrink-0 text-xs leading-5 text-[var(--text-secondary)]">项目组：</span>
                            <span className="flex-1 min-w-0 truncate" title={groupName}>{groupName}</span>
                        </div>
                        <div
                            data-name="memo-project-readonly"
                            className="flex text-sm"
                            title={projectPath}>
                            <span className="w-14 shrink-0 text-xs leading-5 text-[var(--text-secondary)]">项目：</span>
                            <span className="flex-1 min-w-0 truncate">
                                {projectLabel(projectPath)}{' '}
                                <span className="text-xs text-[var(--text-secondary)]">{projectPath}</span>
                            </span>
                        </div>
                    </div>
                ) : (
                    <div className="flex gap-2">
                        <div className="flex-1 min-w-0">
                            <label className="block text-xs text-[var(--text-secondary)] mb-1">项目组</label>
                            <select
                                value={projectGroupId}
                                onChange={(e) => handleGroupChange(e.target.value)}
                                className={`w-full px-2 py-1.5 text-xs bg-[var(--surface-muted)] rounded border border-[var(--border)] ${INPUT_FOCUS}`}
                                data-name="memo-group-select">
                                <option value="">未分组</option>
                                {groups.map((g) => (
                                    <option key={g.id} value={g.id}>{g.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="flex-1 min-w-0">
                            <label className="block text-xs text-[var(--text-secondary)] mb-1">项目</label>
                            <select
                                value={projectPath}
                                onChange={(e) => {
                                    cascadeTouchedRef.current = true
                                    setProjectPath(e.target.value)
                                }}
                                className={`w-full px-2 py-1.5 text-xs bg-[var(--surface-muted)] rounded border border-[var(--border)] ${INPUT_FOCUS}`}
                                data-name="memo-project-select">
                                <option value="">未选择项目</option>
                                {projectOptions.map((p) => (
                                    <option key={p} value={p}>{projectLabel(p)}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}
                {/* 附件缩略图区：位于标题与正文之间（修订 2 Task D） */}
                {attachments.length > 0 && (
                    <div data-testid="memo-attachment-area" className="flex flex-wrap gap-2">
                        {attachments.map(renderAttachmentCard)}
                    </div>
                )}
                <div>
                    <label className="block text-xs text-[var(--text-secondary)] mb-1">正文</label>
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
                        className={`w-full px-2 py-1.5 text-xs bg-[var(--surface-muted)] rounded border border-[var(--border)] resize-y placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
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
                        className="px-2 py-1 rounded text-xs border border-dashed border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-brand)] hover:border-[var(--border-emphasis)]"
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
                {cascadeTip && <div className="text-xs text-[var(--error)]">{cascadeTip}</div>}
                {tip && <div className="text-xs text-[var(--error)]">{tip}</div>}
            </div>
            {/* 底部操作栏 */}
            <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border-muted)]">
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
            {/* 图片附件大图预览：复用统一看图组件（zoom/rotate/drag/右键复制） */}
            {preview && (
                <ImagePreviewModal src={preview.src} alt={preview.alt} onClose={() => setPreview(null)}/>
            )}
        </div>
    )
}
