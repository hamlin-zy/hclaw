/**
 * TaskUpdate 工具 — 更新/清理待办事项
 *
 * - status: 批量更新指定 taskId 列表的状态
 * - clear=true & 无 status: 清空指定 taskId 列表中的已完成任务
 * - clear=true & 无 taskId: 清空所有已完成任务
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {taskStore} from '../../tasks/taskStore'
import type {TaskStatus} from '@shared/types'

const inputSchema = z.object({
    taskId: z.union([z.string(), z.array(z.string())]).optional()
        .describe('任务 ID 列表，批量操作时使用'),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'error']).optional()
        .describe('新的任务状态（设置此值则批量更新状态）'),
    clear: z.boolean().optional().describe('清空模式：根据 taskId 清理指定的已完成任务，无 taskId 时清空所有已完成任务'),
})

type TaskUpdateInput = z.infer<typeof inputSchema>

export const taskUpdateTool: Tool<TaskUpdateInput, { updated: number; cleared: number; status?: TaskStatus }> = {
    name: 'task_update',
    description: '更新或清理待办事项。taskId 支持数组批量操作；status 指定新状态；clear=true 清空指定的已完成任务（无 taskId 则清空所有已完成）。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: TaskUpdateInput, _context: ToolContext): Promise<ToolResult<{ updated: number; cleared: number; status?: TaskStatus }>> {
        try {
            // 标准化 taskId 为数组
            const ids: string[] | undefined = args.taskId
                ? Array.isArray(args.taskId) ? args.taskId : [args.taskId]
                : undefined

            // ── 清空已完成任务 ──────────────────────────
            if (args.clear && !args.status) {
                const allTasks = taskStore.getAllTasks()
                let cleared = 0
                const toClear = ids
                    ? allTasks.filter(t => ids.includes(t.id) && t.status === 'completed')
                    : allTasks.filter(t => t.status === 'completed')
                for (const t of toClear) {
                    taskStore.deleteTask(t.id)
                    cleared++
                }
                return {
                    success: true,
                    output: {updated: 0, cleared, status: undefined},
                    tasks: taskStore.getAllTasks(),
                }
            }

            // ── 批量更新状态 ──────────────────────────
            if (args.status !== undefined) {
                const allTasks = taskStore.getAllTasks()
                let updated = 0
                const targets = ids
                    ? allTasks.filter(t => ids.includes(t.id))
                    : allTasks
                for (const t of targets) {
                    const result = taskStore.updateTaskStatus(t.id, args.status)
                    if (result) updated++
                }
                return {
                    success: true,
                    output: {updated, cleared: 0, status: args.status},
                    tasks: taskStore.getAllTasks(),
                }
            }

            // 参数无效
            return {
                success: false,
                output: {updated: 0, cleared: 0},
                error: '请提供 status（更新状态）或 clear=true（清理已完成任务）',
            }
        } catch (err) {
            return {
                success: false,
                output: {updated: 0, cleared: 0},
                error: err instanceof Error ? err.message : 'Unknown error',
            }
        }
    },
}
