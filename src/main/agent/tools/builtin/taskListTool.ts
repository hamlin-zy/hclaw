/**
 * TaskList 工具 — 列出所有待办事项
 *
 * 用于查看当前所有待办事项及其状态。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {taskStore} from '../../tasks/taskStore'
import type {Task, TaskStatus} from '@shared/types'

const inputSchema = z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'error']).optional()
        .describe('按状态过滤（可选）'),
})

type TaskListInput = z.infer<typeof inputSchema>

const STATUS_TEXT: Record<TaskStatus, string> = {
    pending: '⏳ 待处理',
    running: '🔄 进行中',
    completed: '✅ 已完成',
    failed: '❌ 失败',
    error: '⚠️ 错误',
    success: '✅ 成功',
}

export const taskListTool: Tool<TaskListInput, Task[]> = {
    name: 'task_list',
    description: '列出所有待办事项及其状态。可以按状态过滤。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: TaskListInput, _context: ToolContext): Promise<ToolResult<Task[]>> {
        try {
            let tasks: Task[] = taskStore.getAllTasks()

            // 按状态过滤
            if (args.status) {
                tasks = tasks.filter((t: Task) => t.status === args.status)
            }

            // 格式化输出
            const formatted = tasks.map((t: Task) => {
                const statusText = STATUS_TEXT[t.status] || t.status

                return `• ${t.title} [${statusText}]${t.description ? `\n  ${t.description}` : ''}`
            }).join('\n')

            return {
                success: true,
                output: tasks,
            }
        } catch (err) {
            return {
                success: false,
                output: [],
                error: err instanceof Error ? err.message : 'Unknown error',
            }
        }
    },
}
