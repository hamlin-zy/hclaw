import {useEffect, useMemo, useState} from 'react'
import type {PhraseItem} from '@shared/types/phrase'
import {usePhraseStore, subscribePhraseChanged} from '../../stores/phraseStore'
import {filterPhrases} from '../../utils/phrase'
import {confirm} from '../ConfirmDialog'

/** 短语编辑区（新增与编辑共用）：textarea + 取消/保存按钮 */
function PhraseEditor({draft, onChange, onCancel, onSave}: {
    draft: string
    onChange: (v: string) => void
    onCancel: () => void
    onSave: () => void
}) {
    return (
        <div className="space-y-2">
            <textarea
                value={draft}
                onChange={e => onChange(e.target.value)}
                placeholder="输入短语内容…"
                rows={4}
                autoFocus
                className="w-full px-2 py-1.5 text-sm bg-[var(--surface-muted)] rounded border border-[var(--border)] focus:outline-none focus:border-[var(--border-emphasis)] resize-y"
            />
            <div className="flex justify-end gap-2">
                <button onClick={onCancel} className="px-3 py-1 text-xs rounded bg-[var(--surface-muted)] border border-[var(--border)] hover:bg-[var(--surface-hover)]">取消</button>
                <button onClick={onSave} className="px-3 py-1 text-xs rounded bg-[var(--brand-primary)] text-white hover:opacity-90">保存</button>
            </div>
        </div>
    )
}

export default function PhraseDialog() {
    const phrases = usePhraseStore((s) => s.phrases)
    const load = usePhraseStore((s) => s.load)
    const create = usePhraseStore((s) => s.create)
    const updateItem = usePhraseStore((s) => s.updateItem)
    const remove = usePhraseStore((s) => s.remove)

    const [query, setQuery] = useState('')
    const [editingId, setEditingId] = useState<string | null>(null) // null=非编辑；'new'=新增
    const [draft, setDraft] = useState('')

    useEffect(() => {
        void load()
        return subscribePhraseChanged()
    }, [load])

    const sorted = useMemo(() => [...phrases].sort((a, b) => b.createdAt - a.createdAt), [phrases])
    const filtered = useMemo(() => filterPhrases(sorted, query), [sorted, query])

    const startNew = () => { setEditingId('new'); setDraft('') }
    const startEdit = (p: PhraseItem) => { setEditingId(p.id); setDraft(p.content) }
    const cancel = () => { setEditingId(null); setDraft('') }
    const save = async () => {
        const content = draft.trim()
        if (!content) return
        if (editingId === 'new') await create({content})
        else if (editingId) await updateItem(editingId, content)
        setEditingId(null); setDraft('')
    }
    const doRemove = async (p: PhraseItem) => {
        const ok = await confirm({title: '删除快捷短语', message: '确定删除该快捷短语？', confirmText: '删除', confirmVariant: 'danger'})
        if (ok) await remove(p.id)
    }

    return (
        <div className="flex flex-col h-full text-[var(--text-primary)]" data-testid="phrase-dialog">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
                <div className="relative flex-1">
                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" aria-hidden="true">
                        <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
                    </svg>
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="搜索短语…"
                        className="w-full pl-8 pr-3 py-1.5 text-sm bg-[var(--surface-muted)] rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] placeholder-[var(--text-muted)]"
                    />
                </div>
                <button onClick={startNew} className="px-3 py-1.5 text-xs rounded bg-[var(--brand-primary)] text-white hover:opacity-90" data-name="phrase-dialog-add-button">
                    新增
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                {/* 新增编辑项：顶部插入（spec §6.1） */}
                {editingId === 'new' && (
                    <PhraseEditor draft={draft} onChange={setDraft} onCancel={cancel} onSave={() => void save()} />
                )}

                {filtered.length === 0 && editingId === null ? (
                    <div className="text-center text-sm text-[var(--text-muted)] py-10">
                        {phrases.length === 0
                            ? '还没有快捷短语，点击右上角「新增」创建第一条'
                            : `未找到匹配 "${query}" 的短语`}
                    </div>
                ) : (
                    filtered.map(p => (
                        <div key={p.id}>
                            {editingId === p.id ? (
                                <PhraseEditor draft={draft} onChange={setDraft} onCancel={cancel} onSave={() => void save()} />
                            ) : (
                                <div className="group flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[var(--surface-muted)] cursor-pointer" onClick={() => startEdit(p)}>
                                    <span className="flex-1 min-w-0 truncate text-sm text-[var(--text-primary)]">{p.content}</span>
                                    <button
                                        onClick={e => { e.stopPropagation(); void doRemove(p) }}
                                        className="opacity-0 group-hover:opacity-100 text-xs text-[var(--text-muted)] hover:text-red-500"
                                        data-name="phrase-dialog-delete-button"
                                    >删除</button>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}
