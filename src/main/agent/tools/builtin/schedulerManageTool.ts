/**
 * scheduler_manage 工具 — 定时任务管理
 *
 * 支持：列出、查看详情、创建、更新、删除、立即执行（action 依次为
 * list / get / create / update / delete / run_now）。
 *
 * 边界：**没有 stop / pause / resume 动作**——终止正在运行的任务、暂停与恢复都只在界面侧，
 * 走 IPC 通道 `scheduler-stop` / `scheduler-pause` / `scheduler-resume`（出口同为 scheduleOps）。
 * 本工具的 action 枚举里不存在它们，文件头注释与运行时 description 都不得声称支持。
 *
 * 取数一律走 scheduleOps —— 与 IPC 通道同一出口，因此工具路径与界面路径
 * 的可观察结果形状完全一致（{ok, data} | {ok, error}），此处只负责把它翻译成 ToolResult。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {
    createSchedule, deleteSchedule, getSchedule, listSchedules, runNowSchedule, updateSchedule,
} from '../../../scheduler/scheduleOps'
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
    description: '定时任务管理。支持列出所有任务、查看详情、创建、更新、删除、立即执行任务。' +
        '通过 action 参数区分操作。' +
        '例如："每天9点定时发送日报"→ action=create, name=日报, cronExpression="0 9 * * *", taskType=agent, taskTarget=日报技能名。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: SchedulerManageInput, context: ToolContext): Promise<ToolResult<string>> {
        try {
            switch (args.action) {
                case 'list': {
                    const listed = listSchedules()
                    if (!listed.ok) {
                        return {success: false, output: '', error: listed.error}
                    }
                    const records = listed.data
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
                    const found = getSchedule(args.id)
                    if (!found.ok) {
                        return {success: false, output: '', error: found.error}
                    }
                    const record = found.data
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
                    // 根据当前工作目录自动获取 workspaceId
                    const wsRepo = new SqliteWorkspaceRepository()
                    const ws = context.workingDir ? wsRepo.getByPath(context.workingDir) : null
                    const created = createSchedule({
                        name: args.name,
                        description: args.description || '',
                        cronExpression: args.cronExpression,
                        taskType: args.taskType,
                        taskTarget: args.taskTarget,
                        taskArgs: args.taskPrompt ? [args.taskPrompt] : [],
                        enabled: args.enabled !== false,
                        workspaceId: ws?.id || null,
                    })
                    if (!created.ok) {
                        return {success: false, output: '', error: created.error}
                    }
                    context.onEvent?.({type: 'schedules-changed', change: {type: 'created', record: created.data}})
                    return {success: true, output: `✅ 定时任务已创建: ${args.name} (ID: ${created.data.id.slice(0, 8)}...)`}
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

                    const updated = updateSchedule(args.id, updates)
                    if (!updated.ok) {
                        return {success: false, output: '', error: updated.error}
                    }
                    context.onEvent?.({type: 'schedules-changed', change: {type: 'updated', record: updated.data}})
                    return {success: true, output: `✅ 定时任务已更新: ${updated.data.id.slice(0, 8)}...`}
                }

                case 'delete': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'delete 操作需要提供 id。'}
                    }
                    // 广播要用**解析后**的完整 id：本工具对外回显的是 8 位短 id，
                    // agent 会复用它来调用，而渲染层按完整 id 匹配本地行——原样透传短 id
                    // 会让「就地删除」退化成整表重取（口径与界面路径不一致）。
                    const target = getSchedule(args.id)
                    if (!target.ok) {
                        return {success: false, output: '', error: target.error}
                    }
                    const removed = deleteSchedule(target.data.id)
                    if (!removed.ok) {
                        return {success: false, output: '', error: removed.error}
                    }
                    context.onEvent?.({type: 'schedules-changed', change: {type: 'deleted', id: target.data.id}})
                    return {success: true, output: `✅ 定时任务已删除: ${target.data.id.slice(0, 8)}...`}
                }

                case 'run_now': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'run_now 操作需要提供 id。'}
                    }
                    const result = await runNowSchedule(args.id)
                    if (result.ok) {
                        // 立即执行本身不改记录：广播读回后的记录（触发状态由引擎异步落库，
                        // 与「改后整表重取」读到的是同一份状态），让各窗口就地更新那一行。
                        const fresh = getSchedule(args.id)
                        if (fresh.ok) {
                            context.onEvent?.({type: 'schedules-changed', change: {type: 'updated', record: fresh.data}})
                        }
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
