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
    batch_name: z.string().optional()
        .describe('开启新任务组时提供组名；不传则系统自动判定（当前组内仍有未完成任务时归入当前组）'),
})

type TaskCreateInput = z.infer<typeof inputSchema>

export const taskCreateTool: Tool<TaskCreateInput, { taskId: string; title: string }> = {
    name: 'task_create',
    description: '创建新的待办事项任务。可选提供详细描述。任务按任务组（批次）分批管理：默认归入当前未完成的任务组，全部完成后再次创建会开启新任务组；batch_name 可显式开启新任务组。创建后任务状态为"待处理"。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: TaskCreateInput, context: ToolContext): Promise<ToolResult<{ taskId: string; title: string }>> {
        try {
            // 任务归属当前会话（子会话的待办只属于子会话，不与主会话共享）
            const convId = context.conversationId
            const task = taskStore.createTask(convId, args.title, args.description, args.batch_name)

            return {
                success: true,
                output: {
                    taskId: task.id,
                    title: task.title,
                },
                tasks: taskStore.getAllTasks(convId),
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
