/**
 * TaskCreate 工具 — 创建待办事项
 *
 * 用于创建新的待办事项任务。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {taskStore} from '../../tasks/taskStore'

const inputSchema = z.object({
    title: z.string().min(1).describe('任务标题'),
    description: z.string().optional().describe('任务详细描述'),
})

type TaskCreateInput = z.infer<typeof inputSchema>

export const taskCreateTool: Tool<TaskCreateInput, { taskId: string; title: string }> = {
    name: 'task_create',
    description: '创建新的待办事项任务。可选提供详细描述。创建后任务状态为"待处理"。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: TaskCreateInput, _context: ToolContext): Promise<ToolResult<{ taskId: string; title: string }>> {
        try {
            const task = taskStore.createTask(args.title, args.description)

            
            return {
                success: true,
                output: {
                    taskId: task.id,
                    title: task.title,
                },
                tasks: taskStore.getAllTasks(),
            }
        } catch (err) {
            return {
                success: false,
                output: {taskId: '', title: ''},
                error: err instanceof Error ? err.message : 'Unknown error',
            }
        }
    },
}
