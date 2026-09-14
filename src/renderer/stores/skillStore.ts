/**
 * 技能状态 Store
 *
 * 管理技能列表、匹配结果、执行状态、日志等。
 *
 * 写操作（addSkill/removeSkill/toggleSkill/toggleSkillBatch/updateSkillDescription/
 * updateSkillContent/installSkill）统一走 applyOptimistic：先乐观改写内存 → 持久化 →
 * 失败回滚，错误统一规范化为字符串；不再「每次变更全量重载 + withSkillLoading」。
 * 只读刷新（loadSkills/refreshSkills）与运行时执行态（matchedSkills/currentExecution/
 * executionHistory 与 onSkill* 事件）保持原样。
 */

import {create} from 'zustand'
import type {Skill} from '@shared/types'
import type {SkillBubbleProps, SkillLogEntry} from '../components/skill/SkillBubble'
import {applyOptimistic} from './applyOptimistic'

// ─── 类型定义 ─────────────────────────────────────────

interface SkillExtensions {
  references: string[]
  scripts: string[]
  templates: string[]
}

type ExecutionStatus = 'matched' | 'loading' | 'executing' | 'done' | 'error'
type ScriptStatus = 'pending' | 'running' | 'done' | 'error'

interface SkillExecutionRecord {
  executionId: string
  skillId: string
  skillName: string
  status: ExecutionStatus
  phase?: string
  currentStep?: string
  progress?: { current: number; total: number; label?: string }
  references?: { loaded: string[]; pending?: string[] }
  script?: { name: string; status: ScriptStatus; output?: string; error?: string }
  logs: SkillLogEntry[]
  result?: { type: 'inline' | 'script_output' | 'reference'; content: string }
  error?: { phase: string; message: string }
  startTime: number
  endTime?: number
}

interface MatchedSkill {
  skillId: string
  skillName: string
  score: number
  reason: string
}

interface SkillStore {
  // 技能列表
  skills: Skill[]
  /** 上次刷新时的加载错误列表 */
  loadErrors: Array<{ skillDir: string; filePath: string; error: string; timestamp: number }>
  initialized: boolean
  loading: boolean

    // 匹配技能记录
  matchedSkills: MatchedSkill[]

  // 扩展信息缓存
  extensionsCache: Record<string, SkillExtensions>

  // 运行时状态
  currentExecution: SkillExecutionRecord | null
  executionHistory: SkillExecutionRecord[]

    // 基础操作
  loadSkills: () => Promise<void>
  refreshSkills: () => Promise<void>
  installSkill: () => Promise<{ success: boolean; skillName?: string; error?: string }>
  addSkill: (skill: { name: string; description: string; content?: string; enabled?: boolean; allowedTools?: string[] }) => Promise<{ success: boolean; skillDirName?: string; error?: string }>
    removeSkill: (id: string) => Promise<{ success: boolean; error: string }>
    toggleSkill: (id: string) => Promise<{ success: boolean; enabled?: boolean; error: string }>
    toggleSkillBatch: (skillIds: string[], enabled: boolean) => Promise<{ success: boolean; error: string }>
    updateSkillDescription: (id: string, userDescription: string) => Promise<{ success: boolean; error: string }>
  updateSkillContent: (params: {skillId: string; name?: string; description?: string; body?: string}) => Promise<{ success: boolean; error: string }>

  // 运行时操作
  onSkillMatched: (skillId: string, skillName: string, reason: string) => void
  onSkillStart: (executionId: string, skillId: string, mode: string) => void
  onPhaseChange: (phase: string, message?: string, progress?: { current: number; total: number }) => void
  onReferenceLoaded: (refName: string) => void
  onScriptStart: (scriptName: string) => void
  onScriptOutput: (output: string) => void
  onScriptDone: (exitCode: number) => void
  onScriptError: (error: string) => void
  onLog: (level: SkillLogEntry['type'], message: string) => void
  onSkillComplete: (result?: { type: string; content?: string }) => void
  onSkillError: (phase: string, message: string) => void
  clearCurrentExecution: () => void
  clearExecutionHistory: () => void
}

// ─── 辅助函数 ─────────────────────────────────────────

/** 创建日志条目 */
const createLog = (type: SkillLogEntry['type'], message: string, data?: unknown): SkillLogEntry => ({
  timestamp: Date.now(),
  type,
  message,
  ...(data ? {data} : {}),
})

/** 技能刷新成功回调：更新列表+错误 */
const SKILLS_REFRESHED = (r: {skills: any[]; loadErrors?: SkillStore['loadErrors']}) => ({
  skills: r.skills as Skill[],
  loadErrors: r.loadErrors || [],
})

/** 更新 execution 记录（不可变合并） */
const updateExecution = (
  current: SkillExecutionRecord | null,
  updates: Partial<SkillExecutionRecord>,
): SkillExecutionRecord | null => {
  if (!current) return null
  return {...current, ...updates}
}

/** 通用 immutable 更新 currentExecution + 追加日志 */
const updateExecWithLog = (
  current: SkillExecutionRecord | null,
  updates: Partial<SkillExecutionRecord>,
  log?: {type: SkillLogEntry['type']; message: string; data?: unknown},
): SkillExecutionRecord | null => {
  if (!current) return null
  return {
    ...current,
    ...updates,
    ...(log ? {logs: [...current.logs, createLog(log.type, log.message, log.data)]} : {}),
  }
}

/** 执行 IPC 调用并以 loading 状态包装 */
async function withSkillLoading<T>(
  set: (partial: Partial<SkillStore>) => void,
  ipcCall: () => Promise<T> | undefined,
  onSuccess?: (result: T) => Omit<Partial<SkillStore>, 'loading'>,
): Promise<T | {success: false; error: string}> {
  set({loading: true})
  try {
    const result = await ipcCall()
    if (result && typeof result === 'object' && 'success' in result && result.success) {
      set({...(onSuccess ? onSuccess(result as T) : {}), loading: false})
    } else {
      set({loading: false})
    }
    return result as T
  } catch (err: unknown) {
    set({loading: false})
    return {success: false, error: (err as Error).message}
  }
}

/** 将 execution 转换为 SkillBubbleProps */
const toBubbleProps = (exec: SkillExecutionRecord): SkillBubbleProps => ({
    skillName: exec.skillName,
    status: exec.status,
    phase: exec.phase,
    currentStep: exec.currentStep,
    progress: exec.progress,
    references: exec.references,
    script: exec.script,
    logs: exec.logs,
    result: exec.result,
    error: exec.error,
    startTime: exec.startTime,
    endTime: exec.endTime,
})

// ─── Store 实现 ───────────────────────────────────────

export const useSkillStore = create<SkillStore>((set, get) => ({
  skills: [],
  loadErrors: [],
  initialized: false,
  loading: false,
  matchedSkills: [],
  extensionsCache: {},
  currentExecution: null,
  executionHistory: [],

    // ─── 基础操作 ───────────────────────────────────────

  loadSkills: async () => {
    try {
      const result = await window.electronAPI?.skillsRefresh?.()
      if (result?.success) {
          set({skills: result.skills as Skill[], loadErrors: result.loadErrors || [], initialized: true})
      } else {
          set({initialized: true})
      }
    } catch {
        set({initialized: true})
    }
  },

  refreshSkills: async () => {
      await withSkillLoading(set, () => window.electronAPI?.skillsRefresh?.(true), SKILLS_REFRESHED)
  },

  installSkill: async () => {
    const zipPath = await window.electronAPI?.openSkillFileDialog?.()
    if (!zipPath) return {success: false, error: 'User cancelled'}

    const prev = get().skills
    const result = await applyOptimistic<Skill[], {success: boolean; skillName?: string; skills?: Skill[]}>({
      // 安装产出的技能需主进程扫描后才可知，无法预置乐观项 → mutate 置空；
      // 仍复用 applyOptimistic 以统一错误字符串与「不触发全量 loading/重载」的契约
      snapshot: () => {
        set({skills: prev})
        return prev
      },
      mutate: () => undefined,
      persist: async () => {
        const r = await window.electronAPI?.skillInstall?.(zipPath)
        if (!r?.success) throw new Error(r?.error || '安装技能失败')
        return r as {success: boolean; skillName?: string; skills?: Skill[]}
      },
    })

    if (!result.ok) return {success: false, error: result.error}
    // 主进程返回的列表为权威（含新技能）；缺失时保留既有列表
    if (Array.isArray(result.data.skills)) set({skills: result.data.skills as Skill[]})
    return {success: true, skillName: result.data.skillName}
  },

  addSkill: async (skill) => {
    const now = Date.now()
    const optimistic: Skill = {
      id: `optimistic:${now}`,
      name: skill.name,
      description: skill.description,
      content: skill.content || '',
      enabled: skill.enabled ?? true,
      version: '',
      source: 'user',
      allowedTools: skill.allowedTools,
    }
    const prev = get().skills

    const result = await applyOptimistic<Skill[], {success: boolean; skillDirName?: string; skills?: Skill[]}>({
      snapshot: () => {
        set({skills: prev})
        return prev
      },
      mutate: () => set({skills: [...prev, optimistic]}),
      persist: async () => {
        const r = await window.electronAPI?.skillAdd?.({
          name: skill.name,
          description: skill.description,
          content: skill.content || '',
          enabled: skill.enabled,
          allowedTools: skill.allowedTools,
        })
        if (!r?.success) throw new Error(r?.error || '创建技能失败')
        return r as {success: boolean; skillDirName?: string; skills?: Skill[]}
      },
    })

    if (!result.ok) return {success: false, error: result.error}
    if (Array.isArray(result.data.skills)) set({skills: result.data.skills as Skill[]})
    return {success: true, skillDirName: result.data.skillDirName}
  },

  removeSkill: async (id) => {
    const prev = get().skills
    const result = await applyOptimistic<Skill[], {success: boolean; skills?: Skill[]}>({
      snapshot: () => {
        set({skills: prev})
        return prev
      },
      mutate: () => set({skills: prev.filter(s => s.id !== id)}),
      persist: async () => {
        const r = await window.electronAPI?.skillRemove?.(id)
        if (!r?.success) throw new Error(r?.error || '删除技能失败')
        return r as {success: boolean; skills?: Skill[]}
      },
    })

    if (!result.ok) return {success: false, error: result.error}
    if (Array.isArray(result.data.skills)) set({skills: result.data.skills as Skill[]})
    return {success: true, error: ''}
  },

  toggleSkill: async (id) => {
    const prev = get().skills
    const target = !(prev.find(s => s.id === id)?.enabled ?? false)
    const result = await applyOptimistic<Skill[], {success: boolean; enabled?: boolean; skills?: Skill[]}>({
      snapshot: () => {
        set({skills: prev})
        return prev
      },
      mutate: () => set({skills: prev.map(s => (s.id === id ? {...s, enabled: target} : s))}),
      persist: async () => {
        const r = await window.electronAPI?.skillToggle?.(id)
        if (!r?.success) throw new Error(r?.error || '切换技能状态失败')
        return r as {success: boolean; enabled?: boolean; skills?: Skill[]}
      },
    })

    if (!result.ok) return {success: false, error: result.error}
    if (Array.isArray(result.data.skills)) set({skills: result.data.skills as Skill[]})
    return {success: true, enabled: result.data.enabled ?? target, error: ''}
  },

  toggleSkillBatch: async (skillIds, enabled) => {
    if (skillIds.length === 0) return {success: true, error: ''}
    const prev = get().skills
    const idSet = new Set(skillIds)
    const result = await applyOptimistic<Skill[], {success: boolean; skills?: Skill[]}>({
      snapshot: () => {
        set({skills: prev})
        return prev
      },
      mutate: () => set({skills: prev.map(s => (idSet.has(s.id) ? {...s, enabled} : s))}),
      persist: async () => {
        const r = await window.electronAPI?.skillToggleBatch?.({skillIds, enabled})
        if (!r?.success) throw new Error(r?.error || '批量切换技能状态失败')
        return r as {success: boolean; skills?: Skill[]}
      },
    })

    if (!result.ok) return {success: false, error: result.error}
    if (Array.isArray(result.data.skills)) set({skills: result.data.skills as Skill[]})
    return {success: true, error: ''}
  },

  updateSkillDescription: async (id, userDescription) => {
    const prev = get().skills
    const result = await applyOptimistic<Skill[], {success: boolean; skills?: Skill[]}>({
      snapshot: () => {
        set({skills: prev})
        return prev
      },
      mutate: () => set({skills: prev.map(s => (s.id === id ? {...s, userDescription} : s))}),
      persist: async () => {
        const r = await window.electronAPI?.skillUpdateDescription?.(id, userDescription) as
          | {success: boolean; skills?: Skill[]; error?: string}
          | undefined
        if (!r?.success) throw new Error(r?.error || '更新技能描述失败')
        return r
      },
    })

    if (!result.ok) return {success: false, error: result.error}
    if (Array.isArray(result.data.skills)) set({skills: result.data.skills as Skill[]})
    return {success: true, error: ''}
  },

  updateSkillContent: async (params) => {
    const prev = get().skills
    const result = await applyOptimistic<Skill[], {success: boolean; skills?: Skill[]}>({
      snapshot: () => {
        set({skills: prev})
        return prev
      },
      mutate: () => set({
        skills: prev.map(s => {
          if (s.id !== params.skillId) return s
          return {
            ...s,
            ...(params.name !== undefined ? {name: params.name} : {}),
            ...(params.description !== undefined ? {description: params.description} : {}),
            ...(params.body !== undefined ? {content: params.body} : {}),
          }
        }),
      }),
      persist: async () => {
        const r = await (window.electronAPI as any)?.updateSkillContent?.(params) as
          | {success: boolean; skills?: Skill[]; error?: string}
          | undefined
        if (!r?.success) throw new Error(r?.error || '保存技能内容失败')
        return r
      },
    })

    if (!result.ok) return {success: false, error: result.error}
    if (Array.isArray(result.data.skills)) set({skills: result.data.skills as Skill[]})
    return {success: true, error: ''}
  },

    // ─── 运行时操作 ───────────────────────────────────────

  onSkillMatched: (skillId, skillName, reason) => {
    set(state => ({
      currentExecution: {
        executionId: `exec-${Date.now()}`,
        skillId,
        skillName,
        status: 'matched',
        logs: [createLog('info', `技能匹配: ${reason}`)],
        startTime: Date.now(),
      },
      matchedSkills: [...state.matchedSkills, {skillId, skillName, score: 0, reason}],
    }))
  },

  onSkillStart: (_executionId, _skillId, _mode) => {
    set(state => ({
      currentExecution: updateExecution(state.currentExecution, {
        status: 'loading',
        phase: 'loading_main',
        currentStep: '加载技能内容...',
      }),
    }))
  },

  onPhaseChange: (phase, message, progress) => {
    set(state => ({
      currentExecution: updateExecution(state.currentExecution, {status: 'executing', phase, currentStep: message, progress}),
    }))
  },

  onReferenceLoaded: (refName) => {
    set(state =>
      state.currentExecution
        ? {
            currentExecution: updateExecWithLog(
              state.currentExecution,
              {
                references: {
                  loaded: [...(state.currentExecution.references?.loaded || []), refName],
                  pending: state.currentExecution.references?.pending?.filter(r => r !== refName),
                },
              },
              {type: 'info', message: `已加载: ${refName}`},
            ),
          }
        : {},
    )
  },

  onScriptStart: (scriptName) => {
    set(state => ({
      currentExecution: updateExecWithLog(
        state.currentExecution,
        {status: 'executing', phase: 'executing_script', currentStep: `执行脚本: ${scriptName}`, script: {name: scriptName, status: 'running'}},
        {type: 'info', message: `开始执行脚本: ${scriptName}`},
      ),
    }))
  },

  onScriptOutput: (output) => {
    set(state =>
      state.currentExecution?.script
        ? {
            currentExecution: updateExecWithLog(
              state.currentExecution,
              {script: {...state.currentExecution!.script, output: (state.currentExecution!.script!.output || '') + output}},
              {type: 'output', message: output.slice(0, 100) + (output.length > 100 ? '...' : ''), data: output},
            ),
          }
        : {},
    )
  },

  onScriptDone: (exitCode) => {
    const success = exitCode === 0
    set(state => ({
      currentExecution: updateExecWithLog(
        state.currentExecution,
        state.currentExecution?.script
          ? {script: {...state.currentExecution.script, status: success ? 'done' : 'error', error: success ? undefined : `Exit code: ${exitCode}`}}
          : {},
        {type: success ? 'info' : 'error', message: `脚本执行${success ? '成功' : '失败'}`},
      ),
    }))
  },

  onScriptError: (error) => {
    set(state => ({
      currentExecution: updateExecWithLog(
        state.currentExecution,
        state.currentExecution?.script ? {script: {...state.currentExecution.script, status: 'error', error}} : {},
        {type: 'error', message: `脚本错误: ${error}`},
      ),
    }))
  },

  onLog: (level, message) => {
    set(state => ({
      currentExecution: updateExecWithLog(state.currentExecution, {}, {type: level, message}),
    }))
  },

  onSkillComplete: (result) => {
    const current = get().currentExecution
    if (!current) return

    const completed: SkillExecutionRecord = {
      ...current,
      status: 'done',
      phase: 'done',
      currentStep: '完成',
        result: result ? {
            type: result.type as 'inline' | 'script_output' | 'reference',
            content: result.content || ''
        } : undefined,
      endTime: Date.now(),
        logs: [...current.logs, createLog('info', '技能执行完成')],
    }

    set({
      currentExecution: completed,
      executionHistory: [...get().executionHistory, completed],
    })
  },

  onSkillError: (phase, message) => {
    const current = get().currentExecution
    if (!current) return

    const error: SkillExecutionRecord = {
      ...current,
      status: 'error',
      phase,
      currentStep: '错误',
        error: {phase, message},
      endTime: Date.now(),
        logs: [...current.logs, createLog('error', `${phase}: ${message}`)],
    }

    set({
      currentExecution: error,
      executionHistory: [...get().executionHistory, error],
    })
  },

    clearCurrentExecution: () => set({currentExecution: null}),
    clearExecutionHistory: () => set({executionHistory: [], currentExecution: null}),
}))

// ─── 辅助 Hook ─────────────────────────────────────────

export function useCurrentSkillBubbleProps(): SkillBubbleProps | null {
  const execution = useSkillStore(state => state.currentExecution)
    return execution ? toBubbleProps(execution) : null
}

export function useSkillExecutionHistory(): SkillBubbleProps[] {
    return useSkillStore(state => state.executionHistory.map(toBubbleProps))
}
