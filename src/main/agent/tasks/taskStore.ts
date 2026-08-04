/**
 * 任务存储 — Worker 内任务状态管理
 *
 * 管理任务的创建、更新和列表维护。
 * 任务按会话隔离：每个 conversationId 拥有独立的任务列表（子会话的任务不共享给主会话）。
 * 任务状态通过 sendMessage 发送给 UI（携带 conversationId，渲染端按会话路由到对应 convData）。
 */

import {randomUUID} from 'crypto'
import type {Task, TaskStatus} from '@shared/types'

// ─── 任务存储类 ──────────────────────────────────────────

class TaskStore {
    /** 按会话隔离的任务存储：convId → taskId → Task */
    private tasksByConv: Map<string, Map<string, Task>> = new Map()
    private sendMessage: ((msg: { type: string; conversationId?: string; tasks?: Task[] }) => void) | null = null
    private _initialized = false

    /** 初始化 store，绑定 sendMessage 函数（防止重复初始化） */
    init(sendMessage: (msg: { type: string; conversationId?: string; tasks?: Task[] }) => void): void {
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

    /** 重置所有任务（保留初始化状态） */
    reset(): void {
        this.tasksByConv.clear()
        this.notifyUpdate('default')
    }

    /** 创建新任务（归属到指定会话） */
    createTask(convId: string | undefined, title: string, description?: string): Task {
        // 使用 crypto.randomUUID() 生成安全的唯一 ID
        const id = `task-${randomUUID()}`
        const task: Task = {
            id,
            title,
            status: 'pending',
            description,
        }
        this.getConvTasks(convId).set(id, task)
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
        this.notifyUpdate(convId)
        return updated
    }

    /** 获取指定会话的所有任务 */
    getAllTasks(convId?: string): Task[] {
        return Array.from(this.getConvTasks(convId).values())
    }

    /** 获取任务 */
    getTask(convId: string | undefined, taskId: string): Task | undefined {
        return this.getConvTasks(convId).get(taskId)
    }

    /** 删除任务 */
    deleteTask(convId: string | undefined, taskId: string): boolean {
        const deleted = this.getConvTasks(convId).delete(taskId)
        if (deleted) {
            this.notifyUpdate(convId)
        }
        return deleted
    }

    /** 通知 UI 更新（携带会话 ID，渲染端按会话路由） */
    private notifyUpdate(convId?: string): void {
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tasks_update',
                conversationId: convId,
                tasks: this.getAllTasks(convId),
            })
        }
    }
}

/** 全局单例 */
export const taskStore = new TaskStore()
