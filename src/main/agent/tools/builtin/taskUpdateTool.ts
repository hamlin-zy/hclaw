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
    description: '更新或清理待办事项。taskId 支持数组批量操作；status 指定新状态；clear=true 清空指定的已完成任务（无 taskId 则清空所有已完成）。将已完成任务改回进行中会重新激活其所属任务组。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: TaskUpdateInput, context: ToolContext): Promise<ToolResult<{ updated: number; cleared: number; status?: TaskStatus }>> {
        try {
            // 任务归属当前会话（子会话的待办只属于子会话，不与主会话共享）
            const convId = context.conversationId

            // 标准化 taskId 为数组
            const ids: string[] | undefined = args.taskId
                ? Array.isArray(args.taskId) ? args.taskId : [args.taskId]
                : undefined

            // ── 清空已完成任务 ──────────────────────────
            if (args.clear && !args.status) {
                const allTasks = taskStore.getAllTasks(convId)
                let cleared = 0
                const toClear = ids
                    ? allTasks.filter(t => ids.includes(t.id) && t.status === 'completed')
                    : allTasks.filter(t => t.status === 'completed')
                for (const t of toClear) {
                    taskStore.deleteTask(convId, t.id)
                    cleared++
                }
                return {
                    success: true,
                    output: {updated: 0, cleared, status: undefined},
                    tasks: taskStore.getAllTasks(convId),
                }
            }

            // ── 批量更新状态 ──────────────────────────
            if (args.status !== undefined) {
                const allTasks = taskStore.getAllTasks(convId)
                let updated = 0
                const targets = ids
                    ? allTasks.filter(t => ids.includes(t.id))
                    : allTasks
                for (const t of targets) {
                    const result = taskStore.updateTaskStatus(convId, t.id, args.status)
                    if (result) updated++
                }
                // ★ 明确失败语义：指定了 taskId 却一个都没更新 → 目标任务不存在。
                //   跨轮场景（worker 重建后内存态为空）曾静默返回 success:true + updated:0，
                //   LLM 误以为更新成功，UI 待办列表保持旧状态。
                if (ids && updated === 0) {
                    return {
                        success: false,
                        output: {updated: 0, cleared: 0},
                        error: `未找到指定任务（${ids.join(', ')}）：任务不存在或不属于当前会话`,
                    }
                }
                return {
                    success: true,
                    output: {updated, cleared: 0, status: args.status},
                    tasks: taskStore.getAllTasks(convId),
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
