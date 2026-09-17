import {create} from 'zustand'
import type {ScheduleChangePayload, ScheduleRecord, ScheduleResult, ScheduleRunStatus} from '@shared/types/schedule'
import type {ScheduleWorkspaceHealthMap} from '@shared/types/scheduleWorkspace'

/**
 * 定时任务列表项 — 共享字段派生自 ScheduleRecord（唯一来源在 @shared/types/schedule）。
 * 仅 UI 专有字段在此追加：
 * - `taskPrompt`：从 taskArgs[0] 派生的提示词
 * - `lastRunStatus`：不再放宽为 string，直接沿用 ScheduleRecord 的 `ScheduleRunStatus`
 *   （失败的唯一取值是 'failure'）——原先放宽成 string 时，渲染层拿 'failed' / 'error'
 *   去比，编译器无从拦截，失败筛选/标签/状态色因此恒不命中。
 */
export type ScheduleUI = Omit<ScheduleRecord, 'pausedAt' | 'lastRunStatus'> & {
  lastRunStatus: ScheduleRunStatus
  taskPrompt: string
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

/** bridge 缺失时的统一失败结果（消息口径与既有 runNow 兜底一致） */
function apiUnavailable(): ScheduleResult<never> {
  return {ok: false, error: 'scheduler API 不可用'}
}

export const useScheduleStore = create<{
  schedules: ScheduleUI[]; loading: boolean
  /** 加载失败的可读原因（null = 本次加载成功）；与「一条都没有」互斥的显式状态 */
  error: string | null
  /**
   * 每个任务的工作目录健康度 —— 主进程判定、本层只消费（D1/D3：单一出口、只读）。
   * 刻意不并进 `ScheduleUI`：可用性不是任务记录的一部分，不落库、也不该被写回。
   * 取不到时为空表 → 界面按「可用」呈现（不显示标记、不禁用按钮），不制造假故障。
   */
  workspaceHealth: ScheduleWorkspaceHealthMap
  /**
   * 拉取工作目录健康度。
   * 调用时机只有两处：列表取回之后、以及收到配置变更广播之后 —— **不新增轮询定时器**。
   */
  loadWorkspaceHealth: () => Promise<void>
  /**
   * 取回整表。
   *
   * `silent`（静默刷新）：不置 `loading:true`、不清 `error` —— 专供**后台**路径
   * （广播无法就地处理 → 回退重取）使用。用户没点任何东西时列表不该被换成加载态，
   * 更不该因此卸载重挂、丢掉滚动位置（设计契约 M4）。
   * 用户显式点「重试」仍走非静默（那一次就该显示加载态）。
   */
  loadSchedules: (opts?: {silent?: boolean}) => Promise<void>
  create: (data: Partial<ScheduleUI>) => Promise<ScheduleResult<ScheduleRecord>>
  update: (id: string, u: Partial<ScheduleUI>) => Promise<ScheduleResult<ScheduleRecord>>
  delete: (id: string) => Promise<ScheduleResult<boolean>>
  stop: (scheduleId: string) => Promise<ScheduleResult<boolean>>
  /** 暂停：临时停跑，配置全留（与「禁用」是两个动作）。成功后主进程广播 updated 就地更新那一行。 */
  pause: (id: string) => Promise<ScheduleResult<ScheduleRecord>>
  /** 恢复：把暂停的任务放回调度。同上，不在这里整表重取。 */
  resume: (id: string) => Promise<ScheduleResult<ScheduleRecord>>
  runNow: (id: string) => Promise<ScheduleResult<boolean>>
}>((set) => {
  const api = () => window.electronAPI?.scheduler

  /**
   * 六条写路径共用的调用样板：桥接缺失（`api()` 为 undefined / 方法不存在）与
   * 返回 undefined 都经可选链短路成 undefined，统一兜底为 apiUnavailable()。
   * 与 `const res = await api()?.X?.(...); if (!res) return apiUnavailable(); return res` 等价。
   */
  const call = async <T>(fn?: () => Promise<ScheduleResult<T>> | undefined): Promise<ScheduleResult<T>> =>
    (await fn?.()) ?? apiUnavailable()

  /**
   * 健康度取数（loadSchedules 与 loadWorkspaceHealth 共用同一次实现）。
   * 失败一律降级为「不放标记」：它是**只读派生量**，取不到不该升级成列表级错误态，
   * 也不该让整表换成 loading（M4）。
   */
  const fetchWorkspaceHealth = async (): Promise<void> => {
    const call = api()?.workspaceHealth
    if (!call) return
    try {
      const res = await call()
      if (!res || !res.ok) return
      set({workspaceHealth: res.data || {}})
    } catch {
      // 静默：健康度是只读派生量，取不到就不显示标记；列表本身的失败态由 loadSchedules 负责。
    }
  }

  return {
    schedules: [], loading: false, error: null, workspaceHealth: {},

    // 失败不再被拍成空数组：区分「后端返回 ok:false（带可读原因）」与
    // 「桥接缺失（window.electronAPI.scheduler / list 不存在）」，两者都写进 error。
    // silent：后台路径专用 —— 不置 loading、不清 error（列表不闪、滚动位置不丢，M4）。
    loadSchedules: async (opts) => {
      const silent = opts?.silent === true
      if (!silent) set({loading: true, error: null})
      try {
        const list = api()?.list
        if (!list) { set({schedules: [], error: 'scheduler API 不可用'}); return }
        const res = await list()
        if (!res) { set({schedules: [], error: 'scheduler API 不可用'}); return }
        if (!res.ok) {
          set({schedules: [], error: res.error || '定时任务加载失败'})
          return
        }
        set({schedules: res.data.map(toUI), error: null})
        // 列表与健康度同源同时刷新：界面上的可用性必须与刚取回的这批任务对得上。
        await fetchWorkspaceHealth()
      } catch (err: unknown) {
        set({schedules: [], error: err instanceof Error ? err.message : String(err)})
      } finally { if (!silent) set({loading: false}) }
    },

    loadWorkspaceHealth: fetchWorkspaceHealth,

    // 写操作不再自行整表重取：主进程成功后会广播带载荷的变更，
    // 统一由下方 applySchedulesChange 就地更新那一行（写失败不广播，行为不变）
    create: async (data) => call(() => api()?.create?.({name: data.name, description: data.description,
      cronExpression: data.cronExpression, taskType: data.taskType, taskTarget: data.taskTarget,
      taskArgs: data.taskArgs || [], enabled: data.enabled !== false,
      workspaceId: data.workspaceId || null})),

    update: async (id, u) => call(() => api()?.update?.(id, u)),

    delete: async (id) => call(() => api()?.delete?.(id)),

    // 停止：只发命令，不在这里整表重取。
    // 运行状态的变化由主进程广播 `updated`（updateRunStatusSafe 写库成功后读回记录），
    // 渲染层就地更新那一行 —— 原先的 `await reload()` 会把整表换成 loading 态、
    // 卸载重挂列表并重置滚动位置（违反 M4）。
    stop: async (scheduleId) => call(() => api()?.stop?.(scheduleId)),

    // 暂停/恢复**不**在这里手动 loadSchedules()：主进程成功后广播带载荷的 `updated`
    // 变更，applySchedulesChange 会就地更新那一行（复用既有增量机制，保住滚动位置）。
    pause: async (id) => call(() => api()?.pause?.(id)),

    resume: async (id) => call(() => api()?.resume?.(id)),

    runNow: async (id) => {
      const apiObj = api()
      if (!apiObj) return apiUnavailable()
      if (!apiObj.runNow) return {ok: false, error: 'scheduler.runNow 不可用'}
      return await apiObj.runNow(id)
    },
  }
})

// ── 配置变更的增量广播消费 ──
// 主进程唯一出口 scheduleBroadcast 发 `schedules-changed` + 可区分载荷
// （界面路径与 scheduler_manage 工具路径同口径）
// → preload index.ts 桥接到 onChanged 回调 → 此处就地更新对应行。
//
// 回退条件（本票验收 3）：收到未知形态的载荷、或载荷指向本地不存在的行
// （deleted / updated 的目标行不在列表里），无法就地更新 → 回退整表重取。
// 回退一律走**静默刷新**：这是后台路径（用户没点任何东西），不该把列表换成
// loading 态、也不该卸载重挂丢掉滚动位置（M4）。

/**
 * 载荷形态兜底校验：非对象 / type 未知 / 记录缺 id 一律视为「不认识」
 */
function isKnownChange(change: unknown): change is ScheduleChangePayload {
    const c = change as {type?: unknown} | null
    return !!c && typeof c === 'object' &&
        (c.type === 'created' || c.type === 'updated' || c.type === 'deleted')
}

/**
 * 广播驱动的健康度刷新的**合并窗口**（票 11 复核 S5）。
 *
 * 一次运行会经 `updateRunStatusSafe` 广播 1~2 次，每个被拦的任务都会如此；渲染层原先
 * 每收到一条就拉一次健康度 → K 个任务被拦就是 K 次取数，而每次取数在主进程是
 * 「一次 sweep × M 次 stat」。这里给一个 150ms 的合并窗口：窗口内的多条广播只换一次取数。
 *
 * 两件事刻意不做：
 * - **不加轮询定时器**（既有测试钉着「假时钟前进 120s、health/list 调用次数为 0」）；
 *   这个定时器只在收到广播时才会被排上，且排上后必定触发一次，不会自续。
 * - 不做「清空再排」（trailing debounce）：运行状态广播是**连续**到来的，持续到来的
 *   事件会把刷新一直往后推（饿死）；这里取「窗口内只排一次」的节流语义，最多滞后 150ms。
 */
const HEALTH_REFRESH_COALESCE_MS = 150
let healthRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleHealthRefresh(): void {
    if (healthRefreshTimer !== null) return
    healthRefreshTimer = setTimeout(() => {
        healthRefreshTimer = null
        void useScheduleStore.getState().loadWorkspaceHealth()
    }, HEALTH_REFRESH_COALESCE_MS)
}

/** 收到一次配置变更 → 就地更新对应行；无法就地处理时静默整表重取 */
function applySchedulesChange(change: unknown): void {
    const state = useScheduleStore.getState()
    // 配置一变，可用性就可能变（用户换成有效工作目录 → 这一行应当立刻恢复）。
    // 就地更新那一行之后补一次健康度取数：不整表重取、不重置滚动位置（M4），也不新增轮询；
    // 取数本身走上面的合并窗口（一次运行的多条广播换一次取数）。

    if (!isKnownChange(change)) { void state.loadSchedules({silent: true}); return }

    if (change.type === 'deleted') {
        if (!state.schedules.some(s => s.id === change.id)) { void state.loadSchedules({silent: true}); return }
        useScheduleStore.setState({schedules: state.schedules.filter(s => s.id !== change.id)})
        scheduleHealthRefresh()
        return
    }

    const record = change.record as ScheduleRecord | undefined
    if (!record || typeof record.id !== 'string') { void state.loadSchedules({silent: true}); return }
    const row = toUI(record)
    const index = state.schedules.findIndex(s => s.id === row.id)
    if (index === -1) {
        // 新增：本地本来就没有这行 → 插入即就地更新。
        // 插到**头部**而非尾部：整表重取的序是 created_at DESC（最新在前），
        // 追加到尾部会让「新建的那条」出现在列表最下面，与重取后的顺序不一致。
        if (change.type === 'created') {
            useScheduleStore.setState({schedules: [row, ...state.schedules]})
            scheduleHealthRefresh()
            return
        }
        // 更新：本地没有这行（漏接广播 / 尚未加载） → 回退整表重取
        void state.loadSchedules({silent: true})
        return
    }
    const next = state.schedules.slice()
    next[index] = row
    useScheduleStore.setState({schedules: next})
    scheduleHealthRefresh()
}

const api = window.electronAPI?.scheduler
api?.onChanged?.((change) => {
    applySchedulesChange(change)
})
