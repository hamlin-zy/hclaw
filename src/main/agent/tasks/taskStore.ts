/**
 * 任务存储 — Worker 内任务状态管理
 *
 * 管理任务的创建、更新和列表维护。
 * 任务状态通过 sendMessage 发送给 UI。
 */

import {randomUUID} from 'crypto'
import type {Task, TaskStatus} from '@shared/types'

// ─── 任务存储类 ──────────────────────────────────────────

class TaskStore {
    private tasks: Map<string, Task> = new Map()
    private sendMessage: ((msg: { type: string; tasks?: Task[] }) => void) | null = null
    private _initialized = false

    /** 初始化 store，绑定 sendMessage 函数（防止重复初始化） */
    init(sendMessage: (msg: { type: string; tasks?: Task[] }) => void): void {
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

    /** 重置所有任务（保留初始化状态） */
    reset(): void {
        this.tasks.clear()
        this.notifyUpdate()
    }

    /** 创建新任务 */
    createTask(title: string, description?: string): Task {
        // 使用 crypto.randomUUID() 生成安全的唯一 ID
        const id = `task-${randomUUID()}`
        const task: Task = {
            id,
            title,
            status: 'pending',
            description,
        }
        this.tasks.set(id, task)
        this.notifyUpdate()
        return task
    }

    /** 更新任务状态 */
    updateTaskStatus(taskId: string, status: TaskStatus): Task | null {
        const task = this.tasks.get(taskId)
        if (!task) {
            return null
        }
        const updated = {...task, status}
        this.tasks.set(taskId, updated)
        this.notifyUpdate()
        return updated
    }

    /** 更新任务（完整更新） */
    updateTask(taskId: string, updates: Partial<Pick<Task, 'title' | 'description' | 'status' | 'subtasks'>>): Task | null {
        const task = this.tasks.get(taskId)
        if (!task) {
            return null
        }
        const updated = {...task, ...updates}
        this.tasks.set(taskId, updated)
        this.notifyUpdate()
        return updated
    }

    /** 获取所有任务 */
    getAllTasks(): Task[] {
        return Array.from(this.tasks.values())
    }

    /** 获取任务 */
    getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId)
    }

    /** 删除任务 */
    deleteTask(taskId: string): boolean {
        const deleted = this.tasks.delete(taskId)
        if (deleted) {
            this.notifyUpdate()
        }
        return deleted
    }

    /** 通知 UI 更新 */
    private notifyUpdate(): void {
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tasks_update',
                tasks: this.getAllTasks(),
            })
        }
    }
}

/** 全局单例 */
export const taskStore = new TaskStore()
