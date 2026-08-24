/**
 * 任务存储 — Worker 内任务状态管理
 *
 * 管理任务的创建、更新和列表维护。
 * 任务按会话隔离：每个 conversationId 拥有独立的任务列表（子会话的任务不共享给主会话）。
 * 任务状态通过 sendMessage 发送给 UI（携带 conversationId，渲染端按会话路由到对应 convData）。
 *
 * 批次（batch）：每会话维护一个当前批次，作为任务的逻辑分组。
 * - 首次创建任务时开新批次；存在未完成任务时新任务归入当前批次
 * - 全部任务进入终态后批次置 completed；再次创建任务则开新批次
 * - 显式 batchName 可强制开新批次并取代旧活跃批次
 */

import {randomUUID} from 'crypto'
import type {Task, TaskStatus} from '@shared/types'

/** 终态任务状态集合 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'error', 'success'])

/** 会话当前批次（单槽：被取代/开新批次的旧批次不保留历史） */
interface ConvBatch {
    id: string
    name: string
    status: 'active' | 'completed'
    taskIds: string[]
}

// ─── 事件载荷类型 ────────────────────────────────────────

/** tasks_update 事件载荷（存在批次时附带批次字段） */
export interface TasksUpdateMsg {
    type: 'tasks_update'
    conversationId?: string
    tasks: Task[]
    batchId?: string
    batchName?: string
    batchStatus?: 'active' | 'completed'
}

// ─── worker 桥接序列化 ───────────────────────────────────

/**
 * 将 TaskStore 事件载荷序列化为 postMessage 的 event 对象（worker → 主进程桥接）。
 * 存在批次时必须原样透传 batchId/batchName/batchStatus——
 * 丢弃批次字段会导致主进程持久化旁路（handleStreamEvent）跳过落库，
 * 被取代旧批次的 completed 收尾事件将无法写入 DB（永久滞留 active）。
 */
export function buildTasksUpdateEventPayload(msg: TasksUpdateMsg): Pick<TasksUpdateMsg, 'type' | 'tasks' | 'batchId' | 'batchName' | 'batchStatus'> {
    return {
        type: msg.type,
        tasks: msg.tasks,
        ...(msg.batchId ? {batchId: msg.batchId, batchName: msg.batchName, batchStatus: msg.batchStatus} : {}),
    }
}

// ─── 任务存储类 ──────────────────────────────────────────

class TaskStore {
    /** 按会话隔离的任务存储：convId → taskId → Task */
    private tasksByConv: Map<string, Map<string, Task>> = new Map()
    /** 按会话隔离的当前批次：convId → ConvBatch */
    private batchesByConv: Map<string, ConvBatch> = new Map()
    private sendMessage: ((msg: TasksUpdateMsg) => void) | null = null
    private _initialized = false

    /** 初始化 store，绑定 sendMessage 函数（防止重复初始化） */
    init(sendMessage: (msg: TasksUpdateMsg) => void): void {
        if (this._initialized) {
            return
        }
        this.sendMessage = sendMessage
        this._initialized = true
    }

    /** 检查是否已初始化 */
    isInitialized(): boolean {
        return this._initialized
    }

    /** 获取会话的任务 Map（不存在时惰性创建；空 convId 归入 default，保持向后兼容） */
    private getConvTasks(convId?: string): Map<string, Task> {
        const key = convId || 'default'
        let tasks = this.tasksByConv.get(key)
        if (!tasks) {
            tasks = new Map()
            this.tasksByConv.set(key, tasks)
        }
        return tasks
    }

    /** 判断会话内是否存在非终态任务 */
    private hasIncompleteTasks(convTasks: Map<string, Task>): boolean {
        return Array.from(convTasks.values()).some(t => !TERMINAL_STATUSES.has(t.status))
    }

    /**
     * 同步批次状态（在每次任务增删改后调用，先于事件构建）
     * - 无任务或全部终态 → completed
     * - completed 批次出现非终态任务 → 回 active（重开）
     */
    private syncBatchStatus(convId?: string): void {
        const key = convId || 'default'
        const batch = this.batchesByConv.get(key)
        if (!batch) {
            return
        }
        const convTasks = this.tasksByConv.get(key)
        const hasIncomplete = !!convTasks && this.hasIncompleteTasks(convTasks)
        if (!convTasks || convTasks.size === 0 || !hasIncomplete) {
            batch.status = 'completed'
        } else if (batch.status === 'completed') {
            batch.status = 'active'
        }
    }

    /** 获取会话的当前批次（供水合对比等外部使用），无批次时返回 null */
    getActiveBatch(convId?: string): { id: string; name: string; status: 'active' | 'completed' } | null {
        const batch = this.batchesByConv.get(convId || 'default')
        if (!batch) {
            return null
        }
        return {id: batch.id, name: batch.name, status: batch.status}
    }

    /** 重置所有任务与批次（保留初始化状态） */
    reset(): void {
        this.tasksByConv.clear()
        this.batchesByConv.clear()
        this.notifyUpdate('default')
    }

    /** 创建新任务（归属到指定会话）；batchName 为显式批次名称，非空（trim 后）时强制开新批次 */
    createTask(convId: string | undefined, title: string, description?: string, batchName?: string): Task {
        // 使用 crypto.randomUUID() 生成安全的唯一 ID
        const id = `task-${randomUUID()}`
        const task: Task = {
            id,
            title,
            status: 'pending',
            description,
        }
        const key = convId || 'default'
        const convTasks = this.getConvTasks(convId)

        // 显式 batchName trim 后判空：空串视同未传
        const explicitName = batchName?.trim() || undefined

        // 显式 batchName 或「无活跃批次且无未完成任务」→ 新建批次；否则复用当前批次
        let batch = this.batchesByConv.get(key)
        if (!batch || explicitName || !this.hasIncompleteTasks(convTasks)) {
            // 取代旧活跃批次时，先补发旧批次的 completed 收尾事件（保证 UI 收到完整批次生命周期）
            const oldBatch = batch
            if (oldBatch && oldBatch.status === 'active') {
                oldBatch.status = 'completed'
                this.emitTasksUpdate(convId, oldBatch)
            }
            batch = {
                id: `batch-${randomUUID()}`,
                name: (explicitName ?? title).slice(0, 50),
                status: 'active',
                taskIds: [],
            }
            this.batchesByConv.set(key, batch)
        } else {
            // 复用批次路径：防御性同步批次状态（防止外部状态漂移导致批次状态失真）
            this.syncBatchStatus(convId)
        }
        batch.taskIds.push(id)

        convTasks.set(id, task)
        this.notifyUpdate(convId)
        return task
    }

    /** 更新任务状态 */
    updateTaskStatus(convId: string | undefined, taskId: string, status: TaskStatus): Task | null {
        const convTasks = this.getConvTasks(convId)
        const task = convTasks.get(taskId)
        if (!task) {
            return null
        }
        const updated = {...task, status}
        convTasks.set(taskId, updated)
        this.syncBatchStatus(convId)
        this.notifyUpdate(convId)
        return updated
    }

    /** 更新任务（完整更新） */
    updateTask(convId: string | undefined, taskId: string, updates: Partial<Pick<Task, 'title' | 'description' | 'status' | 'subtasks'>>): Task | null {
        const convTasks = this.getConvTasks(convId)
        const task = convTasks.get(taskId)
        if (!task) {
            return null
        }
        const updated = {...task, ...updates}
        convTasks.set(taskId, updated)
        this.syncBatchStatus(convId)
        this.notifyUpdate(convId)
        return updated
    }

    /** 获取指定会话的所有任务（全量，含历史批次的任务） */
    getAllTasks(convId?: string): Task[] {
        return Array.from(this.getConvTasks(convId).values())
    }

    /**
     * 按批次过滤任务（保持 taskIds 的创建顺序；已删除的任务自动跳过）。
     * ★ 事件载荷必须使用批次作用域：单槽批次模型下会话内存中同时残留
     *   旧批次任务，若发全量列表，主进程 upsertSnapshot 会按新 batch.id
     *   重写全部任务行的 batch_id → 旧批次被吞并成空壳、历史明细错挂。
     */
    private getBatchTasks(convId: string | undefined, batch: ConvBatch): Task[] {
        const convTasks = this.tasksByConv.get(convId || 'default')
        if (!convTasks) {
            return []
        }
        const result: Task[] = []
        for (const id of batch.taskIds) {
            const task = convTasks.get(id)
            if (task) {
                result.push(task)
            }
        }
        return result
    }

    /** 获取会话当前批次的任务列表（批次作用域；无批次时返回空数组） */
    getCurrentBatchTasks(convId?: string): Task[] {
        const batch = this.batchesByConv.get(convId || 'default')
        if (!batch) {
            return []
        }
        return this.getBatchTasks(convId, batch)
    }

    /** 获取任务 */
    getTask(convId: string | undefined, taskId: string): Task | undefined {
        return this.getConvTasks(convId).get(taskId)
    }

    /**
     * Worker 启动时从主进程下发的持久化快照恢复活跃批次（跨轮任务状态恢复）。
     * 幂等：仅当该会话尚无批次/任务数据时恢复；恢复本身不触发事件
     * （渲染端已有实时数据或水合路径，无事件也不会产生 UI 闪烁）。
     */
    seedActiveBatch(convId: string | undefined, snapshot: {id: string; name: string; status: 'active' | 'completed'}, tasks: Task[]): void {
        const key = convId || 'default'
        if (this.batchesByConv.has(key) || (this.tasksByConv.get(key)?.size ?? 0) > 0) return
        this.batchesByConv.set(key, {
            id: snapshot.id,
            name: snapshot.name,
            status: snapshot.status,
            taskIds: tasks.map(t => t.id),
        })
        this.tasksByConv.set(key, new Map(tasks.map(t => [t.id, {...t}])))
    }

    /** 删除任务 */
    deleteTask(convId: string | undefined, taskId: string): boolean {
        const deleted = this.getConvTasks(convId).delete(taskId)
        if (deleted) {
            this.syncBatchStatus(convId)
            this.notifyUpdate(convId)
        }
        return deleted
    }

    /**
     * 发送 tasks_update 事件（携带会话 ID，渲染端按会话路由）。
     * 存在批次时附带 {batchId, batchName, batchStatus}，且 tasks 为批次作用域快照
     * （只含该批次持有的任务，见 getBatchTasks 注释）；无批次时退回会话全量。
     */
    private emitTasksUpdate(convId: string | undefined, batch?: ConvBatch): void {
        if (!this.sendMessage) {
            return
        }
        const tasks = batch ? this.getBatchTasks(convId, batch) : this.getAllTasks(convId)
        this.sendMessage({
            type: 'tasks_update',
            conversationId: convId,
            tasks,
            ...(batch ? {batchId: batch.id, batchName: batch.name, batchStatus: batch.status} : {}),
        })
    }

    /**
     * 通知 UI 更新（携带会话 ID，渲染端按会话路由）。
     * 附带当前批次的 {batchId, batchName, batchStatus}（批次状态已由 syncBatchStatus 先行同步）。
     */
    private notifyUpdate(convId?: string): void {
        this.emitTasksUpdate(convId, this.batchesByConv.get(convId || 'default'))
    }
}

/** 全局单例 */
export const taskStore = new TaskStore()
