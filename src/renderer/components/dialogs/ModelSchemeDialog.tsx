import {useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {
    type ModelRole,
    type ModelScheme,
    type ModelSchemeRole,
    type ModelType,
    switchActiveScheme,
    useModelSchemeStore
} from '../../stores/modelSchemeStore'
import {useLLMStore} from '../../stores/llmStore'
import type {LLMProvider} from '@shared/types'
import {useMenuBarStore} from '../../stores/menuBarStore'
import {createDefaultRoles, MODEL_ROLE_INFO, resolveRoleDisplay} from '@shared/modelSchemeHelpers'
import {renderWorkModeIcon, WORK_MODE_ICONS} from '@shared/roleIcons'

// ─── 共享常量 ─────────────────────────────────────────────────

const EFFORT_OPTIONS = [
    {value: '', label: '禁用'},
    {value: 'low', label: '低'},
    {value: 'medium', label: '中'},
    {value: 'high', label: '高'},
    {value: 'xhigh', label: '极高'},
    {value: 'max', label: '最大'},
] as const

const EFFORT_LABELS: Record<string, string> = {
    auto: '自动', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
}

const EFFORT_COLORS: Record<string, string> = {
    auto: 'text-brand-500', low: 'text-green-500', medium: 'text-amber-500',
    high: 'text-red-500', xhigh: 'text-purple-600', max: 'text-purple-600',
}

/** 更新 roles 数组中指定角色的字段 */
function updateRole(roles: ModelSchemeRole[], targetId: string, updates: Partial<ModelSchemeRole>): ModelSchemeRole[] {
    return roles.map(r => r.id === targetId ? {...r, ...updates} : r)
}

// ─── Model Types Icons (reused from LLMConfigDialog) ──────────────────────────

const MODEL_TYPE_CONFIG = [
    {
        value: 'text' as ModelType,
        label: '文本',
        icon: (<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
        </svg>)
    },
    {
        value: 'multimodal' as ModelType,
        label: '多模态',
        icon: (<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20M2 12h20"/>
        </svg>)
    },
    {
        value: 'image' as ModelType,
        label: '图片',
        icon: (<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
        </svg>)
    },
    {
        value: 'voice' as ModelType,
        label: '语音',
        icon: (<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>)
    },
] as const

const MODEL_TYPE_ICON_MAP = Object.fromEntries(MODEL_TYPE_CONFIG.map(t => [t.value, t.icon]))

// ─── Role Groups by Model Type ───────────────────────────────────────────────

const ROLE_GROUPS: Array<{ type: ModelType; label: string; icon: React.ReactNode; roles: ModelRole[] }> = [
    {type: 'text', label: '文本', icon: MODEL_TYPE_ICON_MAP['text'], roles: ['primary', 'lightweight', 'reasoning']},
    {type: 'image', label: '视觉', icon: MODEL_TYPE_ICON_MAP['image'], roles: ['image_understanding']},
    {type: 'voice', label: '听觉', icon: MODEL_TYPE_ICON_MAP['voice'], roles: ['audio_understanding']},
]

/** 使用默认 provider/model 创建角色列表 */
function createRoles(defaultProvider?: string, defaultModel?: string): ModelSchemeRole[] {
    return createDefaultRoles().map(r => {
        if (r.role === 'primary' && defaultProvider && defaultModel) {
            return {...r, endpointId: defaultProvider, modelId: defaultModel}
        }
        return r
    })
}

// ─── ModelSchemeDialog ────────────────────────────────────────────────────────

export default function ModelSchemeDialog() {
    const {
        schemes,
        activeSchemeId,
        presetTemplates,
        addScheme,
        updateScheme,
        removeScheme,
        duplicateScheme,
        createFromPreset,
    } = useModelSchemeStore()

    const [selectedSchemeId, setSelectedSchemeId] = useState<string | null>(activeSchemeId)
    const [isEditingName, setIsEditingName] = useState(false)
    const [showPresetPicker, setShowPresetPicker] = useState(false)
    const [showAddRole, setShowAddRole] = useState(false)
    const [editingRole, setEditingRole] = useState<ModelSchemeRole | null>(null)

    // 侧边栏宽度调节
    const [sidebarWidth, setSidebarWidth] = useState(220)
    const isResizing = useRef(false)

    // ─── 本地编辑状态 ───────────────────────────────────────

    const [localScheme, setLocalScheme] = useState<ModelScheme | null>(null)
    const storeScheme = schemes.find((s) => s.id === selectedSchemeId) || null

    // 记录上一次选中的 ID，用于判断是否真的切换了方案
    const lastSelectedId = useRef<string | null>(null)

    // 同步逻辑：仅在切换方案或 store 数据发生根本性变化时重置本地草稿
    useEffect(() => {
        if (!storeScheme) {
            setLocalScheme(null)
            return
        }

        const shouldReset =
            selectedSchemeId !== lastSelectedId.current || // 切换了方案
            !localScheme ||                                // 初始加载
            (localScheme.id !== selectedSchemeId)          // 状态错位修复

        if (shouldReset) {
            // 补全缺失的角色：确保 ROLE_GROUPS 中定义的所有角色都在方案中存在
            // 兼容旧方案在新增角色后的自动升级
            const allDefinedRoles: ModelRole[] = ROLE_GROUPS.flatMap(g => g.roles)
            const existingRoles = new Set(storeScheme.roles.map(r => r.role))
            const missingRoles: ModelRole[] = allDefinedRoles.filter(r => !existingRoles.has(r))
            const defaultRoles = createDefaultRoles()
            const rolesToFill = missingRoles.length > 0
                ? [
                    ...storeScheme.roles,
                    ...missingRoles.map(role =>
                            defaultRoles.find(r => r.role === role)
                            ?? {
                                id: crypto.randomUUID(),
                                role,
                                endpointId: '',
                                modelId: '',
                                modelType: 'text' as ModelType,
                                enabled: false
                            }
                    ),
                ]
                : storeScheme.roles

            setLocalScheme({
                ...JSON.parse(JSON.stringify(storeScheme)),
                roles: rolesToFill,
            })
            lastSelectedId.current = selectedSchemeId
        }
    }, [selectedSchemeId, storeScheme])

    // 检查是否已修改 (排除初始 null 情况)
    const isDirty = localScheme && storeScheme
        ? JSON.stringify(localScheme) !== JSON.stringify(storeScheme)
        : false

    const handleSave = () => {
        if (localScheme && selectedSchemeId) {
            updateScheme(selectedSchemeId, localScheme)
        }
    }

    const handleCancel = () => {
        if (storeScheme) {
            setLocalScheme(JSON.parse(JSON.stringify(storeScheme)))
        }
    }

    // ─── 交互逻辑 ──────────────────────────────────────────

    const startResizing = (e: React.MouseEvent) => {
        e.preventDefault()
        isResizing.current = true
        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', stopResizing)
        document.body.style.cursor = 'col-resize'
    }

    const handleMouseMove = (e: MouseEvent) => {
        if (!isResizing.current) return
        const container = document.querySelector('.scheme-dialog-container')
        if (!container) return
        const rect = container.getBoundingClientRect()
        const newWidth = e.clientX - rect.left
        if (newWidth >= 120 && newWidth <= 400) {
            setSidebarWidth(newWidth)
        }
    }

    const stopResizing = () => {
        isResizing.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', stopResizing)
        document.body.style.cursor = 'default'
    }

    const handleCreateFromPreset = (presetId: string) => {
        // 获取当前激活的 provider 和 model，用于初始化新 scheme
        const llmState = useLLMStore.getState()
        const activeProvider = llmState.providers.find(p => p.id === llmState.activeProviderId)
        const activeModel = activeProvider?.models.find(m => m.id === llmState.activeModelId)

        const id = createFromPreset(presetId)
        if (id && activeProvider && activeModel) {
            // 用当前激活的 provider/model 初始化 primary 角色
            updateScheme(id, {
                roles: (schemes.find(s => s.id === id)?.roles || []).map(r =>
                    r.role === 'primary'
                        ? {...r, endpointId: activeProvider.id, modelId: activeModel.id}
                        : r
                ),
            })
            setSelectedSchemeId(id)
            setIsEditingName(true)
            setShowPresetPicker(false)
        } else if (id) {
            setSelectedSchemeId(id)
            setIsEditingName(true)
            setShowPresetPicker(false)
        }
    }

    // 渲染时优先使用本地草稿
    const displayScheme = localScheme

    return (
        <div className="flex h-full min-h-[400px] @container scheme-dialog-container">
            {/* 左侧：方案列表 */}
            <div
                style={{width: sidebarWidth}}
                className="shrink-0 border-r border-gray-100 flex flex-col relative"
            >
                <div className="px-3 py-2.5 border-b border-gray-100">
                    <h4 className="text-sm font-medium text-gray-700">方案列表</h4>
                </div>
                <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
                    {schemes.map((scheme) => (
                        <SchemeListItem
                            key={scheme.id}
                            scheme={scheme}
                            isActive={scheme.id === activeSchemeId}
                            isSelected={scheme.id === selectedSchemeId}
                            onSelect={() => {
                                setSelectedSchemeId(scheme.id)
                                setIsEditingName(false)
                            }}
                            onActivate={() => switchActiveScheme(scheme.id)}
                            onDelete={() => {
                                removeScheme(scheme.id)
                                if (selectedSchemeId === scheme.id) {
                                    setSelectedSchemeId(schemes[0]?.id === scheme.id ? schemes[1]?.id || null : schemes[0]?.id || null)
                                }
                            }}
                        />
                    ))}
                </div>
                <div className="p-2 border-t border-gray-100 space-y-1">
                    <button
                        onClick={() => {
                            // 获取当前激活的 provider 和 model，用于初始化新 scheme
                            const llmState = useLLMStore.getState()
                            const activeProvider = llmState.providers.find(p => p.id === llmState.activeProviderId)
                            const activeModel = activeProvider?.models.find(m => m.id === llmState.activeModelId)

                            const id = addScheme({
                                name: '新方案',
                                roles: createRoles(activeProvider?.id, activeModel?.id),
                                enabled: true,
                            })
                            setSelectedSchemeId(id)
                            setIsEditingName(true)
                        }}
                        className="w-full px-2 py-1.5 text-xs text-brand-500 hover:bg-brand-50 rounded transition-colors"
                    >
                        + 新建方案
                    </button>
                    <button
                        onClick={() => setShowPresetPicker(!showPresetPicker)}
                        className="w-full px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-50 rounded transition-colors flex items-center justify-center gap-1"
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path
                                d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"/>
                        </svg>
                        从模板创建
                    </button>

                    {/* 预设模板选择器 */}
                    <AnimatePresence>
                        {showPresetPicker && (
                            <motion.div
                                initial={{opacity: 0, height: 0}}
                                animate={{opacity: 1, height: 'auto'}}
                                exit={{opacity: 0, height: 0}}
                                className="overflow-hidden"
                            >
                                <div className="py-1 space-y-0.5">
                                    {presetTemplates.map((preset) => (
                                        <button
                                            key={preset.id}
                                            onClick={() => handleCreateFromPreset(preset.id)}
                                            className="w-full px-2 py-1.5 text-left text-xs rounded hover:bg-gray-50 transition-colors"
                                        >
                                            <div className="flex items-center gap-1.5">
                                                <span>{preset.icon}</span>
                                                <div>
                                                    <div className="text-gray-700">{preset.name}</div>
                                                    <div
                                                        className="text-xs text-gray-400">{preset.description}</div>
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Resize Handle (列表和详情中间的竖线) */}
                <div
                    onMouseDown={startResizing}
                    className="absolute -right-0.5 top-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/30 transition-colors z-10"
                />
            </div>

            {/* 右侧：方案编辑 */}
            <div className="flex-1 flex flex-col">
                {displayScheme ? (
                    <>
                        <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {isEditingName ? (
                                    <input
                                        type="text"
                                        value={displayScheme.name}
                                        onChange={(e) =>
                                            setLocalScheme({...displayScheme, name: e.target.value})
                                        }
                                        onBlur={() => setIsEditingName(false)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') setIsEditingName(false)
                                        }}
                                        className="text-sm font-medium text-gray-700 bg-transparent border-b-2 border-gray-300 outline-none"
                                        autoFocus
                                    />
                                ) : (
                                    <h4
                                        className="text-sm font-medium text-gray-700 cursor-text select-none"
                                        onDoubleClick={() => setIsEditingName(true)}
                                        title="双击重命名"
                                    >
                                        {displayScheme.name}
                                    </h4>
                                )}
                                {!isEditingName && (
                                    <button
                                        onClick={() => setIsEditingName(true)}
                                        className="p-0.5 text-gray-300 hover:text-brand-500 transition-colors"
                                        title="重命名"
                                    >
                                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            {/* 描述 */}
                            <div>
                                <label className="block text-xs text-gray-500 mb-1">描述</label>
                                <input
                                    type="text"
                                    value={displayScheme.description || ''}
                                    onChange={(e) =>
                                        setLocalScheme({...displayScheme, description: e.target.value})
                                    }
                                    placeholder="可选的方案描述..."
                                    className="w-full px-2.5 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-md text-gray-700 placeholder-gray-300 focus:border-brand-300 focus:outline-none"
                                />
                            </div>

                            {/* 角色配置 - 按模型类型分组 */}
                            <div className="space-y-6">
                                {ROLE_GROUPS.map(({ type, label, icon }) => (
                                    <div key={type}>
                                        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 pb-1.5 mb-2 border-b border-gray-100">
                                            {icon}
                                            <span>{label}模型</span>
                                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">
                                                {type === 'text' ? '支持思考强度 · 自定义模式' : '不支持思考强度'}
                                            </span>
                                        </div>
                                        <div className={type === 'text'
                                            ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]'
                                            : 'grid grid-cols-1 gap-3 @[500px]:grid-cols-2'
                                        }>
                                            {displayScheme.roles
                                                .filter(r => r.modelType === type)
                                                .map((role) => {
                                                    const isBuiltin = role.role in MODEL_ROLE_INFO
                                                    return (
                                                        <RoleConfigEditor
                                                            key={role.id}
                                                            role={role}
                                                            config={role}
                                                            isBuiltin={isBuiltin}
                                                            onChange={(c) => setLocalScheme({
                                                                ...displayScheme,
                                                                roles: updateRole(displayScheme.roles, role.id, c),
                                                            })}
                                                            onDelete={!isBuiltin ? () => setLocalScheme({
                                                                ...displayScheme,
                                                                roles: displayScheme.roles.filter(r => r.id !== role.id),
                                                            }) : undefined}
                                                            onEdit={type === 'text' ? () => setEditingRole(role) : undefined}
                                                        />
                                                    )
                                                })}
                                        </div>
                                        {type === 'text' && (
                                            <button
                                                onClick={() => setShowAddRole(true)}
                                                className="mt-3 flex items-center gap-1 text-[11px] font-medium text-brand-500 hover:text-brand-600 transition-colors"
                                            >
                                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                    <path d="M12 5v14M5 12h14"/>
                                                </svg>
                                                添加工作模式
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {/* 添加/编辑工作模式弹窗 */}
                            {(showAddRole || editingRole) && (
                                <AddRoleDialog
                                    providers={useLLMStore.getState().providers}
                                    initialRole={editingRole || undefined}
                                    onSave={(data) => {
                                        const effort = (data.thinkingEffort || undefined) as ModelSchemeRole['thinkingEffort']
                                        const roleFields = {
                                            displayName: data.name,
                                            icon: data.icon || undefined,
                                            description: data.description || undefined,
                                            endpointId: data.endpointId,
                                            modelId: data.modelId,
                                            thinkingEffort: effort,
                                            enabled: data.enabled,
                                        }
                                        if (editingRole) {
                                            setLocalScheme({
                                                ...displayScheme!,
                                                roles: displayScheme!.roles.map(r =>
                                                    r.id === editingRole.id ? {...r, ...roleFields} : r
                                                ),
                                            })
                                            setEditingRole(null)
                                        } else {
                                            setLocalScheme({
                                                ...displayScheme!,
                                                roles: [...displayScheme!.roles, {
                                                    id: crypto.randomUUID(),
                                                    role: crypto.randomUUID(),
                                                    modelType: 'text',
                                                    ...roleFields,
                                                }],
                                            })
                                            setShowAddRole(false)
                                        }
                                    }}
                                    onClose={() => {
                                        setShowAddRole(false)
                                        setEditingRole(null)
                                    }}
                                />
                            )}

                        </div>

                        {/* 底部操作 */}
                        <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-end gap-2">
                            <AnimatePresence>
                                {isDirty && (
                                    <motion.div
                                        key="dirty-actions"
                                        initial={{opacity: 0, x: 10}}
                                        animate={{opacity: 1, x: 0}}
                                        exit={{opacity: 0, x: 10}}
                                        className="flex items-center gap-2"
                                    >
                                        <button
                                            onClick={handleCancel}
                                            className="px-3 py-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
                                        >
                                            取消
                                        </button>
                                        <button
                                            onClick={handleSave}
                                            className="px-3 py-1 text-xs bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors"
                                        >
                                            保存更改
                                        </button>
                                    </motion.div>
                                )}
                            </AnimatePresence>

                            {displayScheme.id !== activeSchemeId && displayScheme.enabled && !isDirty && (
                                <button
                                    onClick={() => switchActiveScheme(displayScheme.id)}
                                    className="px-3 py-1 text-xs bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors"
                                >
                                    激活方案
                                </button>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                        请选择或创建一个方案
                    </div>
                )}
            </div>
        </div>
    )
}

// ─── 子组件 ────────────────────────────────────────────────

function SchemeListItem({
                            scheme,
                            isActive,
                            isSelected,
                            onSelect,
                            onActivate,
                            onDelete,
                        }: {
    scheme: ModelScheme
    isActive: boolean
    isSelected: boolean
    onSelect: () => void
    onActivate: () => void
    onDelete: () => void
}) {
    const {updateScheme, duplicateScheme} = useModelSchemeStore()
    const [confirmRemove, setConfirmRemove] = useState(false)

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (confirmRemove) {
            onDelete()
            setConfirmRemove(false)
        } else {
            setConfirmRemove(true)
            // 3秒后自动取消确认状态
            setTimeout(() => setConfirmRemove(false), 3000)
        }
    }

    return (
        <div
            onClick={onSelect}
            onDoubleClick={onActivate}
            className={`w-full group px-2.5 py-2 rounded transition-colors flex items-center justify-between cursor-pointer ${
                isSelected
                    ? 'bg-[var(--brand-muted)] text-[var(--brand-primary)]'
                    : 'text-gray-700 hover:bg-gray-50'
            }`}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                <div
                    className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                        isActive ? 'bg-green-400' : scheme.enabled ? 'bg-gray-300' : 'bg-gray-200'
                    }`}
                />
                <span className="text-[11px] font-medium truncate">{scheme.name}</span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
                {/* 启用/禁用开关 */}
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        updateScheme(scheme.id, {enabled: !scheme.enabled})
                    }}
                    className={`shrink-0 w-6 h-3.5 rounded-full relative transition-colors ${
                        scheme.enabled ? 'bg-brand-500' : 'bg-gray-200'
                    }`}
                >
                    <div
                        className={`absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full transition-all ${
                            scheme.enabled ? 'left-3' : 'left-0.5'
                        }`}
                    />
                </button>

                {/* 克隆按钮 */}
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        duplicateScheme(scheme.id)
                    }}
                    className="p-0.5 text-gray-300 hover:text-brand-500 transition-colors"
                    title="克隆此方案"
                >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                </button>

                {/* 删除按钮 */}
                {confirmRemove ? (
                    <button
                        onClick={handleDelete}
                        className="p-0.5 text-[9px] text-white bg-red-500 rounded hover:bg-red-600 transition-colors"
                    >
                        确认
                    </button>
                ) : (
                    <button
                        onClick={handleDelete}
                        className="p-0.5 text-gray-300 hover:text-red-400 transition-colors"
                        title="删除"
                    >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                        </svg>
                    </button>
                )}
            </div>
        </div>
    )
}


function RoleConfigEditor({
                              role,
                              config,
                              onChange,
                              onDelete,
                              onEdit,
                              isBuiltin = true,
                          }: {
    role: ModelSchemeRole
    config: ModelSchemeRole
    onChange: (config: Partial<ModelSchemeRole>) => void
    onDelete?: () => void
    onEdit?: () => void
    isBuiltin?: boolean
}) {
    const {providers} = useLLMStore()
    const {openDialog} = useMenuBarStore()
    const roleDisplay = resolveRoleDisplay(role)
    const isText = config.modelType === 'text'

    const selectedProvider = providers.find((p) => p.id === config.endpointId)
    const availableModels = selectedProvider?.models.filter((m) => m.enabled) || []

    // 验证：启用但未选择模型
    const showWarning = config.enabled && (!config.endpointId || !config.modelId)
    // 错误：必填但未配置
    const showError = (config.enabled && !isBuiltin) && (!config.endpointId || !config.modelId)

    const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const val = e.target.value
        if (val === 'open-llm-config') {
            openDialog('llm-config')
            return
        }
        onChange({
            ...config,
            endpointId: val,
            modelId: '',
        })
    }

    const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const val = e.target.value
        if (val === 'open-llm-config') {
            openDialog('llm-config')
            return
        }
        onChange({...config, modelId: val})
    }

    const effortValue = config.thinkingEffort
    const isEffortDisabled = !effortValue
    const effortLabel = isEffortDisabled ? '禁用' : EFFORT_LABELS[effortValue] ?? effortValue
    const effortColor = isEffortDisabled ? 'text-gray-400' : EFFORT_COLORS[effortValue] ?? 'text-amber-500'

    return (
        <div className={`p-3 rounded-lg border transition-colors ${
            showError ? 'border-red-200' : showWarning ? 'border-amber-200' : 'border-gray-200 hover:border-gray-300'
        }`}>
            {/* Header: icon + name + description + toggle */}
            <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                    <span className="text-base mt-0.5 shrink-0">{renderWorkModeIcon(roleDisplay.icon)}</span>
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <div className="text-sm font-medium text-gray-800 leading-tight">{roleDisplay.name}</div>
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500 rounded leading-tight">
                                {config.modelType}
                            </span>
                            {isBuiltin && (
                                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-500 rounded leading-tight">内置</span>
                            )}
                        </div>
                        <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-1 leading-snug" title={roleDisplay.description}>
                            {roleDisplay.description || '\u00A0'}
                        </div>
                    </div>
                </div>
                <label className="flex items-center shrink-0 mt-0.5">
                    <input
                        type="checkbox"
                        checked={config.enabled}
                        onChange={(e) => onChange({...config, enabled: e.target.checked})}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-brand-500"
                    />
                </label>
            </div>

            {/* 服务商 + 模型选择 */}
            <div className="mt-3 flex flex-col gap-1.5">
                <div className="grid grid-cols-2 gap-2">
                    <select
                        value={config.endpointId}
                        onChange={handleProviderChange}
                        disabled={!config.enabled}
                        className={`w-full px-2 py-1.5 text-[11px] bg-[var(--surface)] border rounded text-gray-700 focus:outline-none disabled:opacity-50 ${
                            showError ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                        }`}
                    >
                        <option value="">服务商</option>
                        {providers
                            .filter((p) => p.enabled)
                            .map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        <option disabled>───────</option>
                        <option value="open-llm-config" className="text-brand-500 font-medium">⚙️ LLM 配置</option>
                    </select>

                    <select
                        value={config.modelId}
                        onChange={handleModelChange}
                        disabled={!config.enabled || !config.endpointId}
                        className={`w-full px-2 py-1.5 text-[11px] bg-[var(--surface)] border rounded text-gray-700 focus:outline-none disabled:opacity-50 ${
                            showError ? 'border-red-300 focus:border-red-400' : 'border-gray-200 focus:border-brand-300'
                        }`}
                    >
                        <option value="">模型</option>
                        {availableModels.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.name}
                            </option>
                        ))}
                        <option disabled>───────</option>
                        <option value="open-llm-config" className="text-brand-500 font-medium">⚙️ LLM 配置</option>
                    </select>
                </div>
            </div>

            {/* 思考强度：仅文本模型显示 */}
            {isText && (
                <div className="mt-2 pt-2 border-t border-gray-100">
                    <div className="flex items-center gap-2">
                        <label className="text-[11px] text-gray-500 whitespace-nowrap">思考强度</label>
                        <select
                            value={effortValue || ''}
                            onChange={(e) => onChange({
                                ...config,
                                thinkingEffort: (e.target.value || undefined) as ModelSchemeRole['thinkingEffort'],
                            })}
                            disabled={!config.enabled}
                            className="flex-1 px-2 py-1 text-[11px] bg-[var(--surface)] border border-gray-200 rounded text-gray-700 focus:outline-none focus:border-brand-300 disabled:opacity-50"
                        >
                            {EFFORT_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                        <span className={`text-[11px] font-medium whitespace-nowrap ${effortColor}`}>
                            {isEffortDisabled ? '禁用' : effortLabel}
                        </span>
                    </div>
                </div>
            )}

            {/* 操作按钮 */}
            {isText && (
                <div className="flex justify-end gap-1 mt-1.5">
                    {onEdit && (
                        <button
                            onClick={onEdit}
                            className="px-2 py-0.5 text-[11px] text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded transition-colors"
                            title="编辑工作模式"
                        >
                            编辑
                        </button>
                    )}
                    {!isBuiltin && onDelete && (
                        <button
                            onClick={onDelete}
                            className="px-2 py-0.5 text-[11px] text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                            title="删除此工作模式"
                        >
                            删除
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}

// ─── 添加角色弹窗 ────────────────────────────────────────────

function AddRoleDialog({
                           providers,
                           initialRole,
                           onSave,
                           onClose,
                       }: {
    providers: LLMProvider[]
    initialRole?: ModelSchemeRole
    onSave: (data: { name: string; icon: string; description: string; endpointId: string; modelId: string; thinkingEffort: string | null; enabled: boolean }) => void
    onClose: () => void
}) {
    const roleInfo = initialRole ? MODEL_ROLE_INFO[initialRole.role as keyof typeof MODEL_ROLE_INFO] : undefined
    const [name, setName] = useState(initialRole?.displayName || '')
    const [icon, setIcon] = useState(initialRole?.icon || roleInfo?.icon || '')
    const [showIconPicker, setShowIconPicker] = useState(false)
    const iconPickerRef = useRef<HTMLDivElement>(null)
    const [description, setDescription] = useState(initialRole?.description || roleInfo?.description || '')
    const [endpointId, setEndpointId] = useState(initialRole?.endpointId || '')
    const [modelId, setModelId] = useState(initialRole?.modelId || '')
    const [thinkingEffort, setThinkingEffort] = useState(initialRole?.thinkingEffort || '')
    const [enabled, setEnabled] = useState(initialRole?.enabled ?? true)
    const {openDialog} = useMenuBarStore()

    useEffect(() => {
        if (!showIconPicker) return
        const handleClickOutside = (e: MouseEvent) => {
            if (iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
                setShowIconPicker(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [showIconPicker])

    // 按 ESC 关闭弹窗
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [onClose])

    const selectedProvider = providers.find((p) => p.id === endpointId)
    const availableModels = selectedProvider?.models.filter((m: any) => m.enabled) || []

    const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const val = e.target.value
        if (val === 'open-llm-config') {
            openDialog('llm-config')
            return
        }
        setEndpointId(val)
        setModelId('')
    }

    const handleSave = () => {
        if (!name.trim()) return
        onSave({
            name: name.trim(),
            icon: icon.trim(),
            description: description.trim(),
            endpointId,
            modelId,
            thinkingEffort: thinkingEffort || null,
            enabled,
        })
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <motion.div
                initial={{opacity: 0, scale: 0.95}}
                animate={{opacity: 1, scale: 1}}
                className="bg-white rounded-xl shadow-xl p-5 w-[400px]"
            >
                <h4 className="text-sm font-semibold text-gray-800 mb-4">{initialRole ? '编辑工作模式' : '添加工作模式'}</h4>
                <div className="space-y-3">
                    <div>
                        <label className="block text-xs text-gray-500 mb-1">模式名称</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="例如：极速模式"
                            className="w-full px-2.5 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded text-gray-700 placeholder-gray-300 focus:border-brand-300 focus:outline-none"
                            autoFocus
                        />
                    </div>

                    {/* 图标选择器 */}
                    <div ref={iconPickerRef} className="relative">
                        <label className="block text-xs text-gray-500 mb-1">图标</label>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setShowIconPicker(!showIconPicker)}
                                className="w-11 h-10 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-center hover:border-brand-300 transition-colors shrink-0 text-[var(--text-secondary)]"
                            >
                                {icon ? renderWorkModeIcon(icon) : <span className="text-base">✨</span>}
                            </button>
                            <div className="text-xs text-gray-400">
                                {icon ? '点击修改图标' : '点击选择一个图标'}
                            </div>
                        </div>
                        {showIconPicker && (
                            <div className="absolute top-full left-0 mt-1 z-20 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-xl shadow-lg p-2.5 w-[340px]">
                                <div className="grid grid-cols-8 gap-1">
                                    {WORK_MODE_ICONS.map((def) => (
                                        <button
                                            key={def.id}
                                            onClick={() => { setIcon(def.id); setShowIconPicker(false) }}
                                            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-[var(--text-secondary)] ${
                                                icon === def.id
                                                    ? 'bg-[var(--brand-primary)]/15 ring-2 ring-[var(--brand-primary)]/40 ring-offset-1'
                                                    : 'hover:bg-[var(--surface-muted)]'
                                            }`}
                                            title={def.id}
                                        >
                                            {def.svg}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    <div>
                        <label className="block text-xs text-gray-500 mb-1">描述</label>
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="可选的模式描述..."
                            className="w-full px-2.5 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded text-gray-700 placeholder-gray-300 focus:border-brand-300 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-gray-500 mb-1">服务商</label>
                        <select
                            value={endpointId}
                            onChange={handleProviderChange}
                            className="w-full px-2 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded text-gray-600 focus:outline-none focus:border-brand-300"
                        >
                            <option value="">选择服务商</option>
                            {providers
                                .filter((p: any) => p.enabled)
                                .map((p: any) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            <option disabled>───────</option>
                            <option value="open-llm-config" className="text-brand-500 font-medium">⚙️ LLM 配置</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-gray-500 mb-1">模型</label>
                        <select
                            value={modelId}
                            onChange={(e) => setModelId(e.target.value)}
                            disabled={!endpointId}
                            className="w-full px-2 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded text-gray-600 focus:outline-none focus:border-brand-300 disabled:opacity-50"
                        >
                            <option value="">选择模型</option>
                            {availableModels.map((m: any) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-gray-500 mb-1">思考强度</label>
                        <select
                            value={thinkingEffort}
                            onChange={(e) => setThinkingEffort(e.target.value)}
                            className="w-full px-2 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded text-gray-600 focus:outline-none focus:border-brand-300"
                        >
                            {EFFORT_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                        <input
                            type="checkbox"
                            id="role-enabled"
                            checked={enabled}
                            onChange={(e) => setEnabled(e.target.checked)}
                            className="w-3.5 h-3.5 rounded border-gray-300 text-brand-500"
                        />
                        <label htmlFor="role-enabled" className="text-xs text-gray-500">启用此工作模式</label>
                    </div>
                </div>
                <div className="flex items-center justify-end gap-2 mt-5">
                    <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                        取消
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!name.trim()}
                        className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors disabled:opacity-50"
                    >
                        {initialRole ? '保存更改' : '添加模式'}
                    </button>
                </div>
            </motion.div>
        </div>
    )
}

