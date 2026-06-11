/**
 * ScheduleEditModal - 定时任务新建/编辑弹窗
 *
 * 特性：
 * 1. 简化为"可用能力"和"本地脚本"两种模式
 * 2. 可用能力：搜索 + 点选列表（合并 Agent/Skill/命令，去重）
 * 3. 本地脚本：输入框 + 浏览按钮 + 系统脚本类型提示
 * 4. 任务提示词替代 JSON 参数
 * 5. 小白友好 Cron 配置器（每天/每周/每月/间隔/高级）
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Switch} from '../common/Switch'
import {useUserCommandStore} from '../../stores/userCommandStore'
import {useAgentTemplateStore} from '../../stores/agentTemplateStore'
import {useSkillStore} from '../../stores/skillStore'
import {fuzzyFilter, fuzzyFilterWithRank} from '../../lib/search'


// ─── 类型定义 ─────────────────────────────────────

export interface ScheduleFormData {
    id?: string
    name: string
    description: string
    taskType: 'agent' | 'skill' | 'command' | 'script'
    taskTarget: string
    taskPrompt: string
    cronExpression: string
    enabled: boolean
    workspaceId: string | null
}

interface ScheduleEditModalProps {
    initial?: Partial<ScheduleFormData>
    onSave: (data: ScheduleFormData) => void
    onClose: () => void
    penetrable?: boolean
}

// ─── 公共样式 ─────────────────────────────────────

const inputCls =
    'w-full px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]'

const labelCls = 'block text-[11px] font-medium text-[var(--text-muted)] mb-1'

// ─── Cron 模式定义 ─────────────────────────────────

type CronMode = 'daily' | 'weekly' | 'monthly' | 'interval' | 'custom'

interface CronConfig {
    mode: CronMode
    dailyHour: number
    dailyMin: number
    weeklyDays: boolean[]
    weeklyHour: number
    weeklyMin: number
    monthlyDate: number
    monthlyHour: number
    monthlyMin: number
    intervalValue: number
    intervalUnit: 'minutes' | 'hours'
    customExpr: string
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const MONTHLY_DATES = Array.from({length: 28}, (_, i) => i + 1)

function makeDefaultConfig(overrides: Partial<CronConfig> = {}): CronConfig {
    return {
        mode: 'daily',
        dailyHour: 9, dailyMin: 0,
        weeklyDays: [false, true, true, true, true, true, false],
        weeklyHour: 9, weeklyMin: 0,
        monthlyDate: 1, monthlyHour: 9, monthlyMin: 0,
        intervalValue: 30, intervalUnit: 'minutes',
        customExpr: '0 9 * * *',
        ...overrides,
    }
}

function cronToConfig(cron: string): CronConfig {
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return makeDefaultConfig({mode: 'custom', customExpr: cron})
    const [min, hour, day, , weekday] = parts

    if (min.startsWith('*/'))
        return makeDefaultConfig({mode: 'interval', intervalValue: parseInt(min.slice(2)) || 30, intervalUnit: 'minutes', customExpr: cron})
    if (hour.startsWith('*/'))
        return makeDefaultConfig({mode: 'interval', intervalValue: parseInt(hour.slice(2)) || 1, intervalUnit: 'hours', customExpr: cron})
    if (weekday !== '*') {
        const days = [false, false, false, false, false, false, false]
        for (const part of weekday.split(',')) {
            const range = part.split('-')
            if (range.length === 2) {
                const [s, e] = range.map(Number)
                for (let i = s; i <= e; i++) days[i] = true
            } else {
                const d = parseInt(part)
                if (d >= 0 && d <= 6) days[d] = true
            }
        }
        return makeDefaultConfig({mode: 'weekly', weeklyDays: days, weeklyHour: parseInt(hour) || 9, weeklyMin: parseInt(min) || 0, customExpr: cron})
    }
    if (day !== '*')
        return makeDefaultConfig({mode: 'monthly', monthlyDate: parseInt(day) || 1, monthlyHour: parseInt(hour) || 9, monthlyMin: parseInt(min) || 0, customExpr: cron})
    return makeDefaultConfig({mode: 'daily', dailyHour: parseInt(hour) || 9, dailyMin: parseInt(min) || 0, customExpr: cron})
}

function configToCron(c: CronConfig): string {
    switch (c.mode) {
        case 'daily':
            return `${c.dailyMin} ${c.dailyHour} * * *`
        case 'weekly': {
            const days = c.weeklyDays.map((v, i) => v ? i : -1).filter(i => i >= 0)
            if (days.length === 0) return `${c.weeklyMin} ${c.weeklyHour} * * *`
            if (days.length >= 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1))
                return `${c.weeklyMin} ${c.weeklyHour} * * ${days[0]}-${days[days.length - 1]}`
            return `${c.weeklyMin} ${c.weeklyHour} * * ${days.join(',')}`
        }
        case 'monthly':
            return `${c.monthlyMin} ${c.monthlyHour} ${c.monthlyDate} * *`
        case 'interval':
            return c.intervalUnit === 'minutes' ? `*/${c.intervalValue} * * * *` : `0 */${c.intervalValue} * * *`
        case 'custom':
            return c.customExpr || '0 9 * * *'
    }
}

function cronToHuman(c: CronConfig): string {
    switch (c.mode) {
        case 'daily':
            return `每天 ${String(c.dailyHour).padStart(2, '0')}:${String(c.dailyMin).padStart(2, '0')}`
        case 'weekly': {
            const days = c.weeklyDays.map((v, i) => v ? WEEKDAY_LABELS[i] : null).filter(Boolean) as string[]
            const dayStr = days.length === 7 ? '每天' : days.length === 5 && !c.weeklyDays[0] && !c.weeklyDays[6] ? '每工作日' : `每周${days.join('、')}`
            return `${dayStr} ${String(c.weeklyHour).padStart(2, '0')}:${String(c.weeklyMin).padStart(2, '0')}`
        }
        case 'monthly':
            return `每月 ${c.monthlyDate} 日 ${String(c.monthlyHour).padStart(2, '0')}:${String(c.monthlyMin).padStart(2, '0')}`
        case 'interval':
            return `每 ${c.intervalValue} ${c.intervalUnit === 'minutes' ? '分钟' : '小时'}`
        case 'custom':
            return c.customExpr || '自定义'
    }
}

// ─── 能力列表组件 ─────────────────────────────────

interface CapabilityItem {
    id: string
    name: string
    description?: string
    sourceLabel: string
    sourceColor: string
}

function CapabilityPicker({selected, onSelect}: {
    selected: string
    onSelect: (name: string, type: string) => void
}) {
    const [search, setSearch] = useState('')
    const [allItems, setAllItems] = useState<CapabilityItem[]>([])
    const [loading, setLoading] = useState(true)
    const userCommands = useUserCommandStore(s => s.commands)
    const agentTemplates = useAgentTemplateStore(s => s.templates)
    const skills = useSkillStore(s => s.skills)

    useEffect(() => {
        loadCapabilities()
    }, [])

    const loadCapabilities = async () => {
        setLoading(true)
        try {
            // 加载数据源
            useUserCommandStore.getState().loadCommands()
            useAgentTemplateStore.getState().syncFromDisk()
            useSkillStore.getState().loadSkills()

            // 等待状态更新后读取 - 用 setTimeout 让 store 完成异步加载
            await new Promise(r => setTimeout(r, 200))

            const items: { item: CapabilityItem; rank: number }[] = []
            const seen = new Set<string>()

            // 从最新 store 读取
            const agents = useAgentTemplateStore.getState().templates
            const skillList = useSkillStore.getState().skills
            const cmdList = useUserCommandStore.getState().commands

            // Agent（优先级最高）
            for (const t of agents) {
                const key = t.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({
                        item: {id: t.name, name: t.name, description: t.description || t.userDescription || '', sourceLabel: 'Agent', sourceColor: 'bg-blue-500/10 text-blue-500'},
                        rank: 0,
                    })
                }
            }

            // Skill
            for (const s of skillList) {
                const key = s.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({
                        item: {id: s.name, name: s.name, description: (s as any).description || '', sourceLabel: 'Skill', sourceColor: 'bg-purple-500/10 text-purple-500'},
                        rank: 1,
                    })
                }
            }

            // 用户命令
            for (const c of cmdList) {
                const key = c.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({
                        item: {id: c.name, name: c.name, description: c.description || '', sourceLabel: '命令', sourceColor: 'bg-amber-500/10 text-amber-500'},
                        rank: 2,
                    })
                }
            }

            // 插件命令
            try {
                const pluginCmds = await window.electronAPI?.plugin?.getCommands?.()
                if (pluginCmds) {
                    for (const [, cmds] of Object.entries<any[]>(pluginCmds)) {
                        for (const cmd of cmds) {
                            const key = cmd.name?.toLowerCase() || cmd.id?.toLowerCase()
                            if (key && !seen.has(key)) {
                                seen.add(key)
                                items.push({
                                    item: {id: cmd.id, name: cmd.name, description: cmd.description || '', sourceLabel: '插件', sourceColor: 'bg-gray-500/10 text-gray-500'},
                                    rank: 3,
                                })
                            }
                        }
                    }
                }
            } catch {}

            setAllItems(items.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name)).map(x => x.item))
        } finally {
            setLoading(false)
        }
    }

    const displayItems = useMemo(() => {
        if (!search.trim()) return allItems
        return fuzzyFilterWithRank(allItems, search, ['name', 'description']).map(r => r.item)
    }, [allItems, search])

    const handleClear = useCallback(() => {
        onSelect('', '')
        setSearch('')
    }, [onSelect])

    return (
        <div>
            <div
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md border border-[var(--border)] shadow-sm focus-within:border-[var(--border-emphasis)] focus-within:shadow-md transition-all">
                {selected && (
                    <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 shrink-0">
                        {selected}
                        <button
                            type="button"
                            onClick={handleClear}
                            className="hover:opacity-70"
                        >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </span>
                )}
                <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={selected ? '' : '搜索可用能力...'}
                    className="flex-1 min-w-0 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
                    autoFocus
                />
            </div>
            <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-[var(--border)]">
                {loading ? (
                    <div className="p-3 text-center text-[10px] text-[var(--text-muted)]">加载中...</div>
                ) : displayItems.length === 0 ? (
                    <div className="p-3 text-center text-[10px] text-[var(--text-muted)]">
                        {search ? '未找到匹配的能力' : '暂无可用能力'}
                    </div>
                ) : (
                    displayItems.map(cap => (
                        <button
                            key={cap.id}
                            onClick={() => {
                                onSelect(cap.name, cap.sourceLabel === 'Agent' ? 'agent' : cap.sourceLabel === 'Skill' ? 'skill' : 'command')
                                setSearch('')
                            }}
                            className={`w-full text-left px-3 py-2 text-xs border-b border-[var(--border)] last:border-b-0 transition-colors ${
                                selected === cap.name
                                    ? 'bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400'
                                    : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                            }`}
                        >
                            <div className="flex items-center gap-1.5">
                                <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${cap.sourceColor}`}>
                                    {cap.sourceLabel}
                                </span>
                                <span className="font-medium">{cap.name}</span>
                            </div>
                            {cap.description && (
                                <div className="mt-0.5 text-[10px] text-[var(--text-muted)] truncate">{cap.description}</div>
                            )}
                        </button>
                    ))
                )}
            </div>
        </div>
    )
}

// ─── 主组件 ─────────────────────────────────────────

export function ScheduleEditModal({initial, onSave, onClose}: ScheduleEditModalProps) {
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [platform, setPlatform] = useState('win32')

    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [taskType, setTaskType] = useState<'agent' | 'skill' | 'command' | 'script'>('agent')
    const [taskTarget, setTaskTarget] = useState('')
    const [taskPrompt, setTaskPrompt] = useState('')
    const [enabled, setEnabled] = useState(true)
    const [error, setError] = useState<string | null>(null)
    // 模式切换: 'capability' | 'script'
    const [mode, setMode] = useState<'capability' | 'script'>('capability')
    const [cron, setCron] = useState<CronConfig>(makeDefaultConfig())
    const [cronExpanded, setCronExpanded] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    // 工作目录
    const [workspaceId, setWorkspaceId] = useState<string | null>(null)
    const [workspaces, setWorkspaces] = useState<Array<{id: string; name: string; path: string}>>([])

    // 检测平台
    useEffect(() => {
        // @ts-ignore - getPlatform is available at runtime via preload
        window.electronAPI?.getPlatform?.().then((p: string) => setPlatform(p || 'win32')).catch(() => {})
    }, [])

    // 加载工作目录列表
    useEffect(() => {
        (async () => {
            try {
                const list = await window.electronAPI?.workspace?.list?.()
                if (list && Array.isArray(list)) {
                    setWorkspaces(list)
                }
            } catch {}
        })()
    }, [])

    // 初始化
    useEffect(() => {
        if (initial) {
            setName(initial.name ?? '')
            setDescription(initial.description ?? '')
            setTaskType(initial.taskType ?? 'agent')
            setTaskTarget(initial.taskTarget ?? '')
            setTaskPrompt(initial.taskPrompt ?? '')
            setEnabled(initial.enabled ?? true)
            setMode(initial.taskType === 'script' ? 'script' : 'capability')
            if (initial.cronExpression) setCron(cronToConfig(initial.cronExpression))
            // 初始化工作目录
            if (initial.workspaceId) {
                setWorkspaceId(initial.workspaceId)
            } else {
                // 未指定工作目录时，使用当前会话的工作目录
                ;(async () => {
                    try {
                        const current = await window.electronAPI?.workspace?.getCurrent?.()
                        if (current) setWorkspaceId(current.id)
                    } catch {}
                })()
            }
        } else {
            // 新建时默认使用当前会话的工作目录
            ;(async () => {
                try {
                    const current = await window.electronAPI?.workspace?.getCurrent?.()
                    if (current) setWorkspaceId(current.id)
                } catch {}
            })()
        }
    }, [initial])

    // ESC 关闭
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [onClose])

    const cronExpr = useMemo(() => configToCron(cron), [cron])
    const cronHuman = useMemo(() => cronToHuman(cron), [cron])

    // textarea 自动增高
    const autoResize = () => {
        const el = textareaRef.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = el.scrollHeight + 'px'
    }

    useEffect(autoResize, [taskPrompt])

    // 脚本类型提示文案
    const scriptTypeHint = useMemo(() => {
        switch (platform) {
            case 'win32': return 'Windows 系统: .bat, .ps1, .cmd, .exe'
            case 'darwin': return 'macOS 系统: .sh, .zsh, .bash'
            case 'linux': return 'Linux 系统: .sh, .bash'
            default: return '脚本文件 (.sh, .bat, .ps1 等)'
        }
    }, [platform])

    // 浏览文件按钮
    const handleBrowse = () => {
        fileInputRef.current?.click()
    }
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) {
            // Electron 中 File 对象有 path 属性返回完整路径
            setTaskTarget((file as any).path || file.name)
            setTaskType('script')
            setMode('script')
        }
        // 清空 input 以允许重复选择同一文件
        e.target.value = ''
    }

    // 选择可用能力
    const handleCapabilitySelect = (name: string, type: string) => {
        setTaskTarget(name)
        setTaskType(type as 'agent' | 'skill' | 'command')
    }

    // 模式切换
    const handleModeSwitch = (newMode: 'capability' | 'script') => {
        setMode(newMode)
        if (newMode === 'script') {
            setTaskType('script')
        }
    }

    const handleSave = useCallback(() => {
        setError(null)
        if (!name.trim()) return setError('任务名称不能为空')
        if (mode === 'capability' && !taskTarget.trim()) return setError('请选择一个可用能力')
        if (mode === 'script' && !taskTarget.trim()) return setError('请填写脚本路径')

        onSave({
            ...(initial?.id ? {id: initial.id} : {}),
            name: name.trim(),
            description: description.trim(),
            taskType,
            taskTarget: taskTarget.trim(),
            taskPrompt: taskPrompt.trim(),
            cronExpression: cronExpr,
            enabled,
            workspaceId: workspaceId || null,
        })
    }, [initial, name, description, taskType, taskTarget, taskPrompt, cronExpr, enabled, mode, onSave, workspaceId])

    const updateCron = useCallback((patch: Partial<CronConfig>) => {
        setCron(prev => ({...prev, ...patch}))
    }, [])

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-xl bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
                 onClick={e => e.stopPropagation()}>
                <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">
                        {!initial?.id ? '新建定时任务' : '编辑定时任务'}
                    </h3>
                    <button onClick={onClose}
                            className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
                    {/* 名称 + 描述 — 并排 */}
                    <div className="flex gap-2">
                        <div className="flex-1 min-w-0">
                            <label className={labelCls}>任务名称</label>
                            <input type="text" value={name} onChange={e => setName(e.target.value)}
                                   placeholder="例如: 每日代码审查" className={inputCls} autoFocus/>
                        </div>
                        <div className="flex-1 min-w-0">
                            <label className={labelCls}>描述 <span className="opacity-60">(可选)</span></label>
                            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                                   placeholder="简短描述" className={inputCls}/>
                        </div>
                    </div>

                    {/* 工作目录 */}
                    <div>
                        <label className={labelCls}>工作目录</label>
                        <select value={workspaceId || ''} onChange={e => setWorkspaceId(e.target.value || null)}
                                className={inputCls}>
                            <option value="">默认工作目录</option>
                            {workspaces.map(ws => (
                                <option key={ws.id} value={ws.id}>
                                    {ws.name} ({ws.path})
                                </option>
                            ))}
                        </select>
                        <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">定时任务创建的会话将归属于此工作目录</p>
                    </div>

                    {/* 模式选择 */}
                    <div>
                        <label className={labelCls}>执行什么？</label>
                        <div className="flex gap-2">
                            <button onClick={() => handleModeSwitch('capability')}
                                    className={`flex-1 px-3 py-2 text-xs rounded-lg border transition-colors ${
                                        mode === 'capability'
                                            ? 'bg-green-50 dark:bg-green-500/10 border-[var(--border)] shadow-sm text-green-600 dark:text-green-400 font-medium'
                                            : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                    }`}>
                                <div className="font-medium">可用能力</div>
                                <div className="text-[10px] opacity-70 mt-0.5">从 Agent / Skill / 命令中选择</div>
                            </button>
                            <button onClick={() => handleModeSwitch('script')}
                                    className={`flex-1 px-3 py-2 text-xs rounded-lg border transition-colors ${
                                        mode === 'script'
                                            ? 'bg-green-50 dark:bg-green-500/10 border-[var(--border)] shadow-sm text-green-600 dark:text-green-400 font-medium'
                                            : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                    }`}>
                                <div className="font-medium">本地脚本</div>
                                <div className="text-[10px] opacity-70 mt-0.5">执行本地文件系统中的脚本</div>
                            </button>
                        </div>
                    </div>

                    {/* 可用能力 — 搜索 + 列表 */}
                    {mode === 'capability' && (
                        <CapabilityPicker selected={taskTarget} onSelect={handleCapabilitySelect}/>
                    )}

                    {/* 本地脚本 — 路径输入 + 浏览 */}
                    {mode === 'script' && (
                        <div>
                            <label className={labelCls}>脚本路径</label>
                            <div className="flex gap-2">
                                <input type="text" value={taskTarget} onChange={e => setTaskTarget(e.target.value)}
                                       placeholder="例如: C:\scripts\backup.ps1" className="flex-1 px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] font-mono"/>
                                <button onClick={handleBrowse}
                                        className="px-3 py-1.5 text-xs rounded-md bg-[var(--surface-muted)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] border border-[var(--border)] transition-colors flex-shrink-0">
                                    浏览
                                </button>
                            </div>
                            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">{scriptTypeHint}</p>
                            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange}
                                   accept={platform === 'win32' ? '.bat,.ps1,.cmd,.exe' : '.sh,.zsh,.bash'}/>
                        </div>
                    )}

                    {/* 任务提示词 — 自动增高 */}
                    <div>
                        <label className={labelCls}>
                            任务提示词
                            <span className="opacity-60 font-normal ml-1">(可选)</span>
                        </label>
                        <textarea ref={textareaRef}
                                  value={taskPrompt}
                                  onChange={e => {
                                      setTaskPrompt(e.target.value)
                                      requestAnimationFrame(autoResize)
                                  }}
                                  placeholder={mode === 'script'
                                      ? '描述脚本的用途和预期输出（仅作记录用途）'
                                      : '告诉 AI 要做什么，例如：请对 src/main 目录下的所有 TypeScript 文件做代码审查'}
                                  className="w-full px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] resize-none min-h-[80px] overflow-hidden"/>
                        {mode !== 'script' && (
                            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">作为 Agent 的初始指令。留空则使用能力本身的默认行为。</p>
                        )}
                    </div>

                    {/* Cron 配置 — 默认折叠 */}
                    <div>
                        <label className={labelCls}>什么时候执行？</label>
                        <button type="button"
                                onClick={() => setCronExpanded(!cronExpanded)}
                                className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-[var(--surface-muted)] rounded-md border border-[var(--border)] hover:bg-[var(--surface)] transition-colors text-left">
                            <span className="flex-1 min-w-0">
                                <span className="text-[var(--text-muted)]">频率: </span>
                                <span className="text-[var(--text-primary)] font-medium">{cronHuman}</span>
                                <code className="ml-1.5 text-[10px] text-[var(--text-muted)] font-mono">({cronExpr})</code>
                            </span>
                            <svg className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform ${cronExpanded ? 'rotate-180' : ''}`}
                                 viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M6 9l6 6 6-6"/>
                            </svg>
                        </button>

                        {cronExpanded && (
                            <>
                                <div className="flex gap-1 mt-1.5 mb-2 flex-wrap">
                                    {([
                                        {key: 'daily' as CronMode, label: '每天'},
                                        {key: 'weekly' as CronMode, label: '每周'},
                                        {key: 'monthly' as CronMode, label: '每月'},
                                        {key: 'interval' as CronMode, label: '间隔'},
                                        {key: 'custom' as CronMode, label: '高级'},
                                    ]).map(tab => (
                                        <button key={tab.key} type="button" onClick={() => updateCron({mode: tab.key})}
                                                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
                                                    cron.mode === tab.key
                                                        ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)] font-medium'
                                                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-[var(--surface)]'
                                                }`}>
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>

                                <div className="bg-[var(--surface-muted)] rounded-md p-3 space-y-2">
                                    {cron.mode === 'daily' && (
                                        <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                                            <span>每天</span>
                                            <input type="number" min={0} max={23} value={cron.dailyHour}
                                                   onChange={e => updateCron({dailyHour: Math.max(0, Math.min(23, parseInt(e.target.value) || 0))})}
                                                   className="w-14 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center"/>
                                            <span>:</span>
                                            <input type="number" min={0} max={59} value={cron.dailyMin}
                                                   onChange={e => updateCron({dailyMin: Math.max(0, Math.min(59, parseInt(e.target.value) || 0))})}
                                                   className="w-14 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center"/>
                                        </div>
                                    )}
                                    {cron.mode === 'weekly' && (
                                        <div className="space-y-2">
                                            <div className="flex gap-1">
                                                {WEEKDAY_LABELS.map((label, i) => (
                                                    <button key={i} type="button" onClick={() => {
                                                        const days = [...cron.weeklyDays]
                                                        days[i] = !days[i]
                                                        updateCron({weeklyDays: days})
                                                    }}
                                                            className={`w-7 h-7 text-xs rounded-full transition-colors ${
                                                                cron.weeklyDays[i]
                                                                    ? 'bg-[var(--brand-primary)] text-white'
                                                                    : 'bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)]'
                                                            }`}>
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-2 text-xs">
                                                <span>时间</span>
                                                <input type="number" min={0} max={23} value={cron.weeklyHour}
                                                       onChange={e => updateCron({weeklyHour: Math.max(0, Math.min(23, parseInt(e.target.value) || 0))})}
                                                       className="w-14 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center"/>
                                                <span>:</span>
                                                <input type="number" min={0} max={59} value={cron.weeklyMin}
                                                       onChange={e => updateCron({weeklyMin: Math.max(0, Math.min(59, parseInt(e.target.value) || 0))})}
                                                       className="w-14 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center"/>
                                            </div>
                                        </div>
                                    )}
                                    {cron.mode === 'monthly' && (
                                        <div className="space-y-2">
                                            <div className="flex items-center gap-2 text-xs flex-wrap">
                                                <span>每月</span>
                                                <select value={cron.monthlyDate}
                                                        onChange={e => updateCron({monthlyDate: parseInt(e.target.value)})}
                                                        className="px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-[var(--text-primary)]">
                                                    {MONTHLY_DATES.map(d => <option key={d} value={d}>{d} 日</option>)}
                                                </select>
                                            </div>
                                            <div className="flex items-center gap-2 text-xs">
                                                <span>时间</span>
                                                <input type="number" min={0} max={23} value={cron.monthlyHour}
                                                       onChange={e => updateCron({monthlyHour: Math.max(0, Math.min(23, parseInt(e.target.value) || 0))})}
                                                       className="w-14 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center"/>
                                                <span>:</span>
                                                <input type="number" min={0} max={59} value={cron.monthlyMin}
                                                       onChange={e => updateCron({monthlyMin: Math.max(0, Math.min(59, parseInt(e.target.value) || 0))})}
                                                       className="w-14 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center"/>
                                            </div>
                                        </div>
                                    )}
                                    {cron.mode === 'interval' && (
                                        <div className="flex items-center gap-2 text-xs">
                                            <span>每</span>
                                            <input type="number" min={1} max={999} value={cron.intervalValue}
                                                   onChange={e => updateCron({intervalValue: Math.max(1, parseInt(e.target.value) || 1)})}
                                                   className="w-16 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center"/>
                                            <select value={cron.intervalUnit}
                                                    onChange={e => updateCron({intervalUnit: e.target.value as 'minutes' | 'hours'})}
                                                    className="px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-[var(--text-primary)]">
                                                <option value="minutes">分钟</option>
                                                <option value="hours">小时</option>
                                            </select>
                                        </div>
                                    )}
                                    {cron.mode === 'custom' && (
                                        <div>
                                            <input type="text" value={cron.customExpr}
                                                   onChange={e => updateCron({customExpr: e.target.value})}
                                                   placeholder="0 9 * * 1-5"
                                                   className="w-full px-3 py-1.5 text-xs font-mono bg-[var(--surface)] rounded border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"/>
                                            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                                                格式: 分 时 日 月 周 &nbsp;
                                                <span className="text-[var(--brand-primary)] cursor-pointer"
                                                      onClick={() => window.electronAPI?.openExternal?.('https://crontab.guru/')}>crontab.guru 查看帮助 ↗</span>
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>

                    {/* 启用 - 开关样式 */}
                    <div className="flex items-center gap-1.5 justify-end pt-1">
                        <span className="text-xs text-[var(--text-primary)]">创建后立即启用</span>
                        <Switch checked={enabled} onChange={setEnabled} />
                    </div>

                    {error && (
                        <div className="p-2 rounded-md bg-red-500/10 text-[11px] text-red-500">{error}</div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)] bg-[var(--surface-muted)]">
                    <button onClick={onClose}
                            className="px-3 py-1.5 text-xs rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors">取消</button>
                    <button onClick={handleSave}
                            className="px-4 py-1.5 text-xs font-medium rounded-md bg-[var(--brand-primary)] text-white hover:opacity-90 transition-opacity">保存</button>
                </div>
            </div>
        </div>
    )
}
