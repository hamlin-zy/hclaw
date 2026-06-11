/**
 * CommandEditModal - 命令编辑/新建弹窗
 *
 * 支持命令名称、描述、标签、模板内容、参数定义的编辑。
 * 新建和编辑共用同一表单。
 */

import React, {useCallback, useEffect, useState} from 'react'
import {UserCommand, useUserCommandStore} from '../../stores/userCommandStore'

interface CommandEditModalProps {
    command: UserCommand | null  // null = 新建模式
    onSave: () => void
    onCancel: () => void
    /** 自定义保存回调（用于插件命令等非标准保存路径） */
    onSaveCustom?: (data: {
        name: string
        description?: string
        content: string
        args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
    }) => Promise<{ success: boolean; error?: string }>
}

// 公共表单输入样式
const inputClass = 'w-full px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]'

interface ArgDef {
    name: string
    description?: string
    required?: boolean
    default?: string
}

export function CommandEditModal({command, onSave, onCancel, onSaveCustom}: CommandEditModalProps) {
    const {createCommand, updateCommand} = useUserCommandStore()

    const isNew = !command

    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [content, setContent] = useState('')
    const [args, setArgs] = useState<ArgDef[]>([])
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [resetting, setResetting] = useState(false)

    useEffect(() => {
        if (command) {
            setName(command.name)
            setDescription(command.description || '')
            setContent(command.content)
            setArgs(command.args || [])
        }
    }, [command])

    const handleSave = useCallback(async () => {
        setError(null)

        // 验证
        if (!name.trim()) return setError('命令名称不能为空')
        if (!/^[\w-]+$/.test(name.trim())) return setError('命令名称只允许字母、数字、下划线和连字符')
        if (!content.trim()) return setError('模板内容不能为空')
        if (args.length > 5) return setError('参数数量不能超过 5 个')

        const data = {
            name: name.trim(),
            description: description.trim() || undefined,
            content: content.trim(),
            args,
        }

        setSaving(true)
        try {
            let success: boolean, errorMsg: string | undefined
            if (onSaveCustom) {
                ({success, error: errorMsg} = await onSaveCustom(data))
            } else if (isNew) {
                ({success, error: errorMsg} = await createCommand({...data, enabled: true}))
            } else {
                ({success, error: errorMsg} = await updateCommand(command!.id, data))
            }
            if (!success) return setError(errorMsg || '操作失败')
            onSave()
        } catch (err: any) {
            setError(err.message)
        } finally {
            setSaving(false)
        }
    }, [name, description, content, args, isNew, command, createCommand, updateCommand, onSave, onSaveCustom])

    // ─── 重置为默认模板 ─────────────────────────────

    const handleReset = useCallback(async () => {
        if (!command) return
        if (!window.electronAPI?.command?.getDefaultTemplate) return
        setError(null)
        setResetting(true)
        try {
            const tmpl = await window.electronAPI.command.getDefaultTemplate(command.name)
            if (!tmpl) {
                setError('当前命令没有内置默认模板')
                return
            }
            setContent(tmpl.content)
            setDescription(tmpl.description || '')
            setArgs(tmpl.args || [])
        } catch (err: any) {
            setError(err.message)
        } finally {
            setResetting(false)
        }
    }, [command])

    // ─── 参数管理 ─────────────────────────────────────

    const addArg = useCallback(() => {
        setArgs(prev => [...prev, {name: '', required: false}])
    }, [])

    const updateArg = useCallback((index: number, field: keyof ArgDef, value: any) => {
        setArgs(prev => prev.map((arg, i) => i === index ? {...arg, [field]: value} : arg))
    }, [])

    const removeArg = useCallback((index: number) => {
        setArgs(prev => prev.filter((_, i) => i !== index))
    }, [])

    // ─── 键盘事件 ─────────────────────────────────────

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onCancel()
            }
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [onCancel])

    // ─── 渲染 ─────────────────────────────────────────

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div
                className="w-full max-w-xl bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* 标题 */}
                <div className="px-5 py-3 border-b border-[var(--border)]">
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">
                        {isNew ? '新建命令' : '编辑命令'}
                    </h3>
                </div>

                {/* 表单 */}
                <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
                    {/* 名称 */}
                    <div>
                        <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">命令名称</label>
                        <input type="text" value={name} onChange={e => setName(e.target.value)}
                               placeholder="例如: explain" className={inputClass} autoFocus/>
                        <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">只允许字母、数字、下划线和连字符</p>
                    </div>

                    {/* 描述 */}
                    <div>
                        <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">描述 <span
                            className="opacity-60">(可选)</span></label>
                        <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                               placeholder="简短描述命令用途" className={inputClass}/>
                    </div>

                    {/* 模板内容 */}
                    <div>
                        <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                            模板内容
                        </label>
                        <textarea
                            value={content}
                            onChange={e => setContent(e.target.value)}
                            placeholder={`# 命令模板，支持 $ARGUMENTS 占位符\n例如：请解释以下代码：\n$ARGUMENTS`}
                            rows={6}
                            className="w-full px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md
                                     text-[var(--text-primary)] placeholder-[var(--text-muted)]
                                     border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]
                                     font-mono resize-y"
                        />
                        <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                            使用 <code className="text-[var(--brand-primary)]">$ARGUMENTS</code> 作为用户输入占位符
                            {content.length > 0 && (
                                <span className="float-right">{content.length}/2000</span>
                            )}
                        </p>
                    </div>

                    {/* 参数定义 */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-[11px] font-medium text-[var(--text-muted)]">
                                参数定义 <span className="text-[var(--text-muted)]">(可选)</span>
                            </label>
                            {args.length < 5 && (
                                <button
                                    onClick={addArg}
                                    className="text-[10px] text-[var(--brand-primary)] hover:underline"
                                >
                                    + 添加参数
                                </button>
                            )}
                        </div>
                        <div className="space-y-1.5">
                            {args.length === 0 && (
                                <p className="text-[10px] text-[var(--text-muted)]">暂未定义参数</p>
                            )}
                            {args.map((arg, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <input type="text" value={arg.name}
                                           onChange={e => updateArg(i, 'name', e.target.value)}
                                           placeholder="参数名"
                                           className="flex-1 px-2 py-1 text-[10px] bg-[var(--surface-muted)] rounded text-[var(--text-primary)] border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"/>
                                    <input type="text" value={arg.default || ''}
                                           onChange={e => updateArg(i, 'default', e.target.value)}
                                           placeholder="默认值"
                                           className="w-20 px-2 py-1 text-[10px] bg-[var(--surface-muted)] rounded text-[var(--text-primary)] border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"/>
                                    <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                                        <input type="checkbox" checked={arg.required || false}
                                               onChange={e => updateArg(i, 'required', e.target.checked)}
                                               className="rounded"/>
                                        必填
                                    </label>
                                    <button onClick={() => removeArg(i)}
                                            className="text-[var(--text-muted)] hover:text-[var(--error)] text-xs px-1">✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* 错误提示 */}
                    {error && (
                        <div className="p-2 rounded-md bg-[var(--error)]/10 text-[11px] text-[var(--error)]">
                            {error}
                        </div>
                    )}
                </div>

                {/* 按钮 */}
                <div
                    className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)] bg-[var(--surface-muted)]">
                    <div>
                        {!isNew && (
                            <button
                                onClick={handleReset}
                                disabled={resetting}
                                className="px-3 py-1.5 text-xs rounded-md text-[var(--text-muted)] hover:text-[var(--warning)] hover:bg-[var(--warning)]/10 transition-colors disabled:opacity-50"
                            >
                                {resetting ? '重置中...' : '重置为默认'}
                            </button>
                        )}
                    </div>
                    <div className="flex gap-2">
                    <button
                        onClick={onCancel}
                        className="px-3 py-1.5 text-xs rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-4 py-1.5 text-xs font-medium rounded-md
                                 bg-[var(--brand-primary)] text-white
                                 hover:opacity-90 transition-opacity
                                 disabled:opacity-50"
                    >
                        {saving ? '保存中...' : '保存'}
                    </button>
                </div>
            </div>
        </div>
        </div>
    )
}
