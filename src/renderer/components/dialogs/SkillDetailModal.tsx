import {useCallback, useEffect, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useSkillStore} from '../../stores/skillStore'
import type {Skill} from '@shared/types'
import {X, Eye, Edit3, Save} from 'lucide-react'

interface SkillDetailModalProps {
    isOpen: boolean
    skill: Skill | null
    mode: 'preview' | 'edit' | 'create'
    onClose: () => void
    onCreateSuccess?: () => void
}

const SKILL_TEMPLATE = [
    '---',
    'name: new-skill',
    'description: 技能的简短描述，用于在技能列表中展示',
    'when_to_use: 描述何时应该使用此技能',
    'enabled: true',
    '---',
    '',
    '# 新技能',
    '',
    '这里写技能的详细指导内容。',
    '',
    '## 使用场景',
    '',
    '描述此技能适用的具体场景。',
    '',
    '## 使用方法',
    '',
    '说明如何使用此技能。',
    '',
    '## 示例',
    '',
    '提供一些使用示例。',
].join('\n')

export default function SkillDetailModal({
    isOpen,
    skill,
    mode: initialMode,
    onClose,
    onCreateSuccess,
}: SkillDetailModalProps) {
    const {updateSkillContent, addSkill} = useSkillStore()
    
    const [mode, setMode] = useState<'preview' | 'edit' | 'create'>(initialMode)
    const [content, setContent] = useState('')
    const [editName, setEditName] = useState('')
    const [editDescription, setEditDescription] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // 从 SKILL.md 文本中解析 name 和 description（frontmatter）
    const parseFrontmatter = useCallback((mdContent: string) => {
        const nameMatch = mdContent.match(/^name:\s*(.+)$/m)
        const descMatch = mdContent.match(/^description:\s*(.+)$/m)
        return {
            name: nameMatch?.[1]?.trim() || '',
            description: descMatch?.[1]?.trim() || '',
        }
    }, [])

    /** 对 YAML 字符串值进行正确引用 */
    const quoteYamlValue = (val: string): string => {
        if (/^[a-zA-Z0-9_\-.]+$/.test(val)) return val
        return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
    }

    /** 用新的 name/description 重构完整的 SKILL.md 文本 */
    const reconstructContent = useCallback((oldContent: string, newName: string, newDesc: string) => {
        const text = oldContent.trimStart()
        const frontmatterMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (frontmatterMatch) {
            const lines = frontmatterMatch[1].split('\n').map(line => {
                if (line.startsWith('name:')) return `name: ${quoteYamlValue(newName)}`
                if (line.startsWith('description:')) return `description: ${quoteYamlValue(newDesc)}`
                return line
            })
            return `---\n${lines.join('\n')}\n---\n${text.slice(frontmatterMatch[0].length).trimStart()}`
        }
        return `---\nname: ${quoteYamlValue(newName)}\ndescription: ${quoteYamlValue(newDesc)}\n---\n\n${text}`
    }, [])

    // 初始化内容 + 可编辑字段
    useEffect(() => {
        setMode(initialMode)
        setError(null)
        let initialContent = ''
        if (initialMode === 'create') {
            initialContent = SKILL_TEMPLATE
        } else if (skill?.content) {
            initialContent = skill.content
        }
        setContent(initialContent)
        const parsed = parseFrontmatter(initialContent)
        setEditName(parsed.name || skill?.name || '')
        setEditDescription(parsed.description || skill?.description || '')
    }, [initialMode, skill, parseFrontmatter])

    // 按 ESC 关闭弹窗
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [onClose])

    const handleSave = useCallback(async () => {
        setIsSaving(true)
        setError(null)
        
        try {
            if (mode === 'create') {
                // 创建模式：reconstructContent 用用户填的 name/desc 更新模板 frontmatter
                const name = editName || 'new-skill'
                const description = editDescription || ''
                const updatedContent = reconstructContent(content, name, description)

                const result = await addSkill({name, description, content: updatedContent, enabled: true})
                if (result.success) {
                    onCreateSuccess?.()
                    onClose()
                } else {
                    setError(result.error || '创建失败')
                }
            } else if (mode === 'edit' && skill?.id) {
                // 编辑模式：前端不拼文件，只发独立字段
                // 后端用 updateMarkdownFrontmatter 合并到原文件，保留其他 frontmatter 字段
                const result = await updateSkillContent({
                    skillId: skill.id,
                    name: editName,
                    description: editDescription,
                    body: content,  // body-only（来自 skill.content + 用户编辑）
                })
                if (result.success) {
                    setMode('preview')
                } else {
                    setError(result.error || '保存失败')
                }
            }
        } finally {
            setIsSaving(false)
        }
    }, [mode, content, skill, editName, editDescription, updateSkillContent, addSkill, onClose, onCreateSuccess])

    const handleEdit = useCallback(() => {
        const parsed = parseFrontmatter(content)
        setEditName(parsed.name || skill?.name || '')
        setEditDescription(parsed.description || skill?.description || '')
        setMode('edit')
    }, [content, skill, parseFrontmatter])

    const handleCancel = useCallback(() => {
        if (mode === 'create') {
            onClose()
        } else if (skill?.content) {
            setContent(skill.content)
            const parsed = parseFrontmatter(skill.content)
            setEditName(parsed.name || skill?.name || '')
            setEditDescription(parsed.description || skill?.description || '')
            setMode('preview')
        } else {
            setContent('')
            setEditName('')
            setEditDescription('')
            setMode('preview')
        }
    }, [mode, skill, onClose, parseFrontmatter])

    const canEdit = skill?.source === 'user' || !skill?.source || mode === 'create'

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* 背景遮罩 — 不绑定关闭事件，防止意外丢失表单数据 */}
                    <motion.div
                        initial={{opacity: 0}}
                        animate={{opacity: 1}}
                        exit={{opacity: 0}}
                        transition={{duration: 0.15}}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[99998]"
                    />
                    
                    {/* 弹窗主体 */}
                    <motion.div
                        initial={{scale: 0.95, opacity: 0}}
                        animate={{scale: 1, opacity: 1}}
                        exit={{scale: 0.95, opacity: 0}}
                        transition={{duration: 0.15}}
                        className="fixed inset-0 flex items-center justify-center p-4 z-[99999] pointer-events-none"
                    >
                        <div
                            className="w-full max-w-3xl max-h-[90vh] bg-[var(--surface)] rounded-xl shadow-elevated overflow-hidden pointer-events-auto flex flex-col"
                            onClick={e => e.stopPropagation()}
                        >
                            {/* Header */}
                            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-elevated)]">
                                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                                    {mode === 'create' ? '创建新技能' : (mode === 'edit' ? '编辑技能' : '技能详情')}
                                </h2>
                                <button
                                    onClick={onClose}
                                    className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                                >
                                    <X className="w-4 h-4"/>
                                </button>
                            </div>

                            {/* Tab buttons (preview/edit) */}
                            {mode !== 'create' && (
                                <div className="flex items-center justify-end gap-2 px-5 py-3 border-b border-[var(--border)]">
                                    <button
                                        onClick={() => setMode('preview')}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                                            mode === 'preview'
                                                ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                        }`}
                                    >
                                        <Eye className="w-3.5 h-3.5"/>
                                        预览
                                    </button>
                                    {canEdit && (
                                        <button
                                            onClick={handleEdit}
                                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                                                mode === 'edit'
                                                    ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                            }`}
                                        >
                                            <Edit3 className="w-3.5 h-3.5"/>
                                            编辑
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* Content */}
                            <div className="flex-1 overflow-y-auto p-5">
                                {/* 元信息区域 */}
                                <div className="mb-6">
                                    <div>
                                        <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1">名称</h4>
                                        {mode === 'edit' || mode === 'create' ? (
                                            <input
                                                value={editName}
                                                onChange={e => setEditName(e.target.value)}
                                                className="w-full px-2.5 py-1.5 text-sm bg-[var(--surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                                            />
                                        ) : (
                                            <div className="text-sm text-[var(--text-primary)] font-medium">{editName || skill?.name || 'new-skill'}</div>
                                        )}
                                    </div>
                                </div>

                                <div className="mb-6">
                                    <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1">描述</h4>
                                    {mode === 'edit' || mode === 'create' ? (
                                        <textarea
                                            value={editDescription}
                                            onChange={e => setEditDescription(e.target.value)}
                                            rows={2}
                                            className="w-full px-2.5 py-1.5 text-sm bg-[var(--surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] resize-y focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                                        />
                                    ) : (
                                        <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
                                            {editDescription || skill?.description || '无描述'}
                                        </div>
                                    )}
                                </div>

                                {skill?.allowedTools && skill.allowedTools.length > 0 && (
                                    <div className="mb-6">
                                        <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1.5">允许的工具</h4>
                                        <div className="flex flex-wrap gap-2">
                                            {skill.allowedTools.map(tool => (
                                                <span
                                                    key={tool}
                                                    className="px-2 py-1 text-xs font-mono rounded bg-[var(--surface-muted)] text-[var(--text-secondary)] border border-[var(--border)]"
                                                >
                                                    {tool}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {skill?.source && (
                                    <div className="mb-6">
                                        <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1">来源</h4>
                                        <div className="text-sm text-[var(--text-secondary)]">
                                            {skill.source === 'builtin' ? '内置' : skill.source === 'plugin' ? '插件' : '自定义'}
                                        </div>
                                    </div>
                                )}

                                {/* 分隔线 */}
                                <div className="border-t border-[var(--border)] my-6" />

                                {/* 内容区域 */}
                                <div>
                                    <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2">技能内容 (SKILL.MD)</h4>
                                    {mode === 'edit' || mode === 'create' ? (
                                        <textarea
                                            value={content}
                                            onChange={e => setContent(e.target.value)}
                                            className="w-full h-80 p-3 text-xs font-mono bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                                            placeholder="输入 SKILL.MD 内容..."
                                            spellCheck={false}
                                        />
                                    ) : (
                                        <pre className="p-3 text-xs font-mono bg-[var(--surface)] border border-[var(--border)] rounded-lg overflow-x-auto whitespace-pre-wrap max-h-80 text-[var(--text-secondary)]">
                                            {content || skill?.content || '无内容'}
                                        </pre>
                                    )}
                                </div>

                                {/* 扩展资源 */}
                                {skill?.extensions && (skill.extensions.references?.length > 0 || skill.extensions.scripts?.length > 0) && (
                                    <>
                                        <div className="border-t border-[var(--border)] my-6" />
                                        <div>
                                            <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2">扩展资源</h4>
                                            {skill.extensions.references?.length > 0 && (
                                                <div className="mb-3">
                                                    <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1">参考文档</div>
                                                    <ul className="space-y-1">
                                                        {skill.extensions.references.map(ref => (
                                                            <li key={ref.name} className="text-xs text-[var(--text-secondary)]">
                                                                {ref.name}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                            {skill.extensions.scripts?.length > 0 && (
                                                <div>
                                                    <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1">脚本</div>
                                                    <ul className="space-y-1">
                                                        {skill.extensions.scripts.map(script => (
                                                            <li key={script.name} className="text-xs text-[var(--text-secondary)]">
                                                                {script.name} ({script.language})
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}

                                {/* 错误提示 */}
                                {error && (
                                    <div className="mt-4 px-3 py-2 text-xs rounded-md bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/20">
                                        {error}
                                    </div>
                                )}
                            </div>

                            {/* Footer (仅在编辑/创建模式下显示） */}
                            {(mode === 'edit' || mode === 'create') && (
                                <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-elevated)]">
                                    <button
                                        onClick={handleCancel}
                                        className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                                    >
                                        {mode === 'create' ? '取消' : '取消编辑'}
                                    </button>
                                    <button
                                        onClick={handleSave}
                                        disabled={isSaving}
                                        className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary)]/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                    >
                                        {isSaving ? (
                                            <>
                                                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                                保存中...
                                            </>
                                        ) : (
                                            <>
                                                <Save className="w-4 h-4"/>
                                                保存
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    )
}
