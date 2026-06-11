/**
 * scheduler_manage 工具 — 定时任务管理
 *
 * 支持：列出、查看详情、创建、更新、删除、立即执行、停止运行中的任务。
 * 通过 action 参数区分操作类型。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {schedulerManager} from '../../../scheduler'
import {scheduleRepo} from '../../../scheduler/ScheduleRepository'
import {SqliteWorkspaceRepository} from '../../../repositories/sqlite/workspaceRepository'

const inputSchema = z.object({
    action: z.enum(['list', 'get', 'create', 'update', 'delete', 'run_now'])
        .describe('操作类型：list=列出所有任务 | get=查看单个任务详情 | create=新建 | update=更新 | delete=删除 | run_now=立即执行'),
    id: z.string().optional().describe('任务ID。get/update/delete/run_now 时必填。'),
    name: z.string().optional().describe('任务名称。create 时必填。'),
    cronExpression: z.string().optional().describe('Cron 表达式，如 "0 9 * * *" 表示每天9点。create 时必填。'),
    taskType: z.enum(['agent', 'skill', 'command', 'script']).optional()
        .describe('任务类型。create 时必填：agent=Agent对话 | skill=执行技能 | command=执行命令 | script=执行脚本'),
    taskTarget: z.string().optional().describe('任务目标。agent/skill 类型填能力名（如 deep-research），script 类型填脚本路径。create 时必填。'),
    taskPrompt: z.string().optional().describe('任务提示词。发送给 Agent 的指令文本，如"搜索全网最新AI新闻"。agent/skill/command 类型建议填写。'),
    enabled: z.boolean().optional().describe('是否启用。'),
    description: z.string().optional().describe('任务描述。'),
})

type SchedulerManageInput = z.infer<typeof inputSchema>

export const schedulerManageTool: Tool<SchedulerManageInput, string> = {
    name: 'scheduler_manage',
    description: '定时任务管理。支持列出所有任务、查看详情、创建、更新、删除、立即执行或停止任务。' +
        '通过 action 参数区分操作。' +
        '例如："每天9点定时发送日报"→ action=create, name=日报, cronExpression="0 9 * * *", taskType=agent, taskTarget=日报技能名。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: SchedulerManageInput, context: ToolContext): Promise<ToolResult<string>> {
        try {
            switch (args.action) {
                case 'list': {
                    const records = scheduleRepo.list()
                    if (records.length === 0) {
                        return {success: true, output: '暂无定时任务。'}
                    }
                    const lines = records.map(r => {
                        const status = r.lastRunStatus === 'running' ? '🔄 运行中' :
                            r.lastRunStatus === 'success' ? '✅ 成功' :
                                r.lastRunStatus === 'failure' ? '❌ 失败' : '⏹️ 未运行'
                        const enabled = r.enabled ? '启用' : '禁用'
                        return `[${r.id}] ${r.name} | cron: ${r.cronExpression} | 类型: ${r.taskType} | ${enabled} | 上次: ${status}`
                    })
                    return {
                        success: true,
                        output: `定时任务列表 (${records.length}):\n` + lines.join('\n')
                    }
                }

                case 'get': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'get 操作需要提供 id。'}
                    }
                    const record = scheduleRepo.get(args.id)
                    if (!record) {
                        return {success: false, output: '', error: `未找到ID为 "${args.id}" 的定时任务。`}
                    }
                    return {
                        success: true,
                        output: [
                            `ID: ${record.id}`,
                            `名称: ${record.name}`,
                            `描述: ${record.description || '(无)'}`,
                            `Cron: ${record.cronExpression}`,
                            `类型: ${record.taskType}`,
                            `目标: ${record.taskTarget}`,
                            `提示词: ${record.taskArgs[0] || '(无)'}`,
                            `启用: ${record.enabled ? '是' : '否'}`,
                            `上次运行: ${record.lastRunAt ? new Date(record.lastRunAt).toLocaleString('zh-CN') : '从未'}`,
                            `上次状态: ${record.lastRunStatus}`,
                            `运行次数: ${record.runCount}`,
                            `创建时间: ${new Date(record.createdAt).toLocaleString('zh-CN')}`,
                        ].join('\n')
                    }
                }

                case 'create': {
                    if (!args.name || !args.cronExpression || !args.taskType || !args.taskTarget) {
                        return {
                            success: false,
                            output: '',
                            error: 'create 操作需要提供 name、cronExpression、taskType、taskTarget。'
                        }
                    }
                    const {randomUUID} = await import('crypto')
                    const id = randomUUID()
                    // 根据当前工作目录自动获取 workspaceId
                    const wsRepo = new SqliteWorkspaceRepository()
                    const ws = context.workingDir ? wsRepo.getByPath(context.workingDir) : null
                    const success = scheduleRepo.create({
                        id,
                        name: args.name,
                        description: args.description || '',
                        cronExpression: args.cronExpression,
                        taskType: args.taskType,
                        taskTarget: args.taskTarget,
                        taskArgs: args.taskPrompt ? [args.taskPrompt] : [],
                        enabled: args.enabled !== false,
                        paused: false,
                        pausedAt: null,
                        workspaceId: ws?.id || null,
                    })
                    if (success) {
                        const record = scheduleRepo.get(id)
                        if (record && record.enabled) {
                            schedulerManager.upsertWorkerSchedule(record)
                        }
                        context.onEvent?.({type: 'schedules-changed'})
                        return {success: true, output: `✅ 定时任务已创建: ${args.name} (ID: ${id.slice(0, 8)}...)`}
                    }
                    return {success: false, output: '', error: '创建定时任务失败。'}
                }

                case 'update': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'update 操作需要提供 id。'}
                    }
                    const updates: Record<string, any> = {}
                    if (args.name !== undefined) updates.name = args.name
                    if (args.description !== undefined) updates.description = args.description
                    if (args.cronExpression !== undefined) updates.cronExpression = args.cronExpression
                    if (args.taskType !== undefined) updates.taskType = args.taskType
                    if (args.taskTarget !== undefined) updates.taskTarget = args.taskTarget
                    if (args.taskPrompt !== undefined) updates.taskArgs = [args.taskPrompt]
                    if (args.enabled !== undefined) updates.enabled = args.enabled
                    if (Object.keys(updates).length === 0) {
                        return {success: false, output: '', error: '请提供至少一个要更新的字段。'}
                    }

                    const success = scheduleRepo.update(args.id, updates)
                    if (success) {
                        const record = scheduleRepo.get(args.id)
                        if (record && record.enabled) schedulerManager.upsertWorkerSchedule(record)
                        else schedulerManager.deleteWorkerSchedule(args.id)
                        context.onEvent?.({type: 'schedules-changed'})
                        return {success: true, output: `✅ 定时任务已更新: ${args.id.slice(0, 8)}...`}
                    }
                    return {success: false, output: '', error: '更新定时任务失败。'}
                }

                case 'delete': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'delete 操作需要提供 id。'}
                    }
                    // 先检查记录是否存在，避免误报成功
                    const existing = scheduleRepo.get(args.id)
                    if (!existing) {
                        return {success: false, output: '', error: `未找到ID为 "${args.id}" 的定时任务。`}
                    }
                    schedulerManager.stop(args.id)
                    schedulerManager.deleteWorkerSchedule(args.id)
                    const success = scheduleRepo.delete(args.id)
                    if (success) {
                        context.onEvent?.({type: 'schedules-changed'})
                        return {success: true, output: `✅ 定时任务已删除: ${args.id.slice(0, 8)}...`}
                    }
                    return {success: false, output: '', error: '删除定时任务失败。'}
                }

                case 'run_now': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'run_now 操作需要提供 id。'}
                    }
                    const result = await schedulerManager.runNow(args.id)
                    if (result.success) {
                        context.onEvent?.({type: 'schedules-changed'})
                        return {success: true, output: `✅ 定时任务 ${args.id.slice(0, 8)}... 已触发执行。`}
                    }
                    return {
                        success: false,
                        output: '',
                        error: `执行失败: ${result.error || '未知错误'}`
                    }
                }

                default:
                    return {success: false, output: '', error: `不支持的操作: ${args.action}`}
            }
        } catch (err) {
            return {
                success: false,
                output: '',
                error: err instanceof Error ? err.message : '操作定时任务失败'
            }
        }
    },
}
