import {create} from 'zustand'

export interface ScheduleUI {
  id: string
  name: string
  description: string
  cronExpression: string
  taskType: 'agent' | 'skill' | 'command' | 'script'
  taskTarget: string
  taskArgs: any[]
  taskPrompt: string
  enabled: boolean
  paused: boolean
  lastRunAt: number | null
  lastRunStatus: string
  lastRunConversationId: string | null
  runCount: number
  createdAt: number
  updatedAt: number
  workspaceId: string | null
}

function toUI(r: any): ScheduleUI {
  const args = r.taskArgs || []
  return {id: r.id, name: r.name, description: r.description, cronExpression: r.cronExpression,
    taskType: r.taskType, taskTarget: r.taskTarget, taskArgs: args,
    taskPrompt: typeof args[0] === 'string' ? args[0] : '',
    enabled: r.enabled, paused: r.paused, lastRunAt: r.lastRunAt, lastRunStatus: r.lastRunStatus,
    lastRunConversationId: r.lastRunConversationId, runCount: r.runCount, createdAt: r.createdAt, updatedAt: r.updatedAt,
    workspaceId: r.workspaceId || null}
}

type ApiResult = {success: boolean; id?: string}

export const useScheduleStore = create<{
  schedules: ScheduleUI[]; loading: boolean
  loadSchedules: () => Promise<void>
  create: (data: Partial<ScheduleUI>) => Promise<ApiResult>
  update: (id: string, u: Partial<ScheduleUI>) => Promise<ApiResult>
  delete: (id: string) => Promise<ApiResult>
  stop: (scheduleId: string) => Promise<void>
  runNow: (id: string) => Promise<{success: boolean; error?: string} | void>
}>((set, get) => {
  const reload = () => get().loadSchedules()
  const api = () => window.electronAPI?.scheduler

  return {
    schedules: [], loading: false,

    loadSchedules: async () => {
      set({loading: true})
      try { set({schedules: ((await api()?.list?.()) || []).map(toUI)}) } finally { set({loading: false}) }
    },

    create: async (data) => {
      const r = await api()?.create?.({name: data.name, description: data.description,
        cronExpression: data.cronExpression, taskType: data.taskType, taskTarget: data.taskTarget,
        taskArgs: data.taskArgs || [], enabled: data.enabled !== false,
        workspaceId: data.workspaceId || null})
      if (r?.success) await reload()
      return r || {success: false}
    },

    update: async (id, u) => {
      const r = await api()?.update?.(id, u)
      if (r?.success) await reload()
      return r || {success: false}
    },

    delete: async (id) => {
      const r = await api()?.delete?.(id)
      if (r?.success) await reload()
      return r || {success: false}
    },

    stop: async (scheduleId) => { await api()?.stop?.(scheduleId); await reload() },
    runNow: async (id) => {
        const apiObj = api()
        if (!apiObj) {
            return {success: false, error: 'scheduler API 不可用'}
        }
        if (!apiObj.runNow) {
            return {success: false, error: 'scheduler.runNow 不可用'}
        }
        return await apiObj.runNow(id)
    },
  }
})

// ── 监听后端工具修改定时任务后推送的变更通知 ──
// scheduler_manage 工具通过 context.onEvent 触发 schedules-changed 事件
// → agent manager.impl.ts 拦截后转发 webContents.send('schedules-changed')
// → preload index.ts 桥接到 onChanged 回调
// → 此处调用 loadSchedules 刷新列表
const api = window.electronAPI?.scheduler
api?.onChanged?.(() => {
  useScheduleStore.getState().loadSchedules()
})
