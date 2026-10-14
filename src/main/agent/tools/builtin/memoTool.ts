/**
 * memo_tool — 备忘录管理
 *
 * 支持：列出、创建、更新、删除备忘录，以及查看可用项目清单（list_projects）。
 * workspacePath 缺省取 context.workingDir；指定 projectGroup/project 时改落到目标项目，不暴露裸路径给 LLM。
 * 写操作（create/update/delete）成功后广播 memo_changed 刷新渲染端列表。
 *
 * 并发说明：本工具在 worker 线程直接调用仓储，与主进程 memoIPC 共用同一存储根，
 * 全局不引入跨线程锁，接受 best-effort 并发（spec §4.2 豁免）。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {memoStore} from '../../../memo/memoStore'
import {broadcastMemoChanged} from '../../../memo/broadcast'
import {workspaceRepo} from '../../../repositories/sqlite/workspaceRepository'
import {projectGroupRepo} from '../../../repositories/sqlite/projectGroupRepository'
import {collectProjectEntries, formatProjectsText, resolveTargetPath} from './memoProjectResolver'
import type {ProjectEntry} from './memoProjectResolver'
import type {MemoItem} from '@shared/types/memo'

const inputSchema = z.object({
    action: z.enum(['list', 'create', 'update', 'delete', 'list_projects'])
        .describe('操作类型：list=列出备忘录 | create=新建 | update=更新 | delete=删除 | list_projects=查看可用项目组与项目'),
    id: z.string().optional().describe('备忘录ID。update/delete 时必填。'),
    title: z.string().optional().describe('标题。create 时必填；title 是给人看的简短摘要。'),
    content: z.string().optional().describe('完整任务描述。create 时必填；content 是完整任务描述，需自包含全部背景与期望结果。'),
    status: z.enum(['active', 'processed']).optional().describe('状态。update 可选：active=待处理 | processed=已处理。'),
    priority: z.enum(['urgent', 'high', 'normal', 'low']).optional()
        .describe('优先级。create/update 可选，根据内容自行判断，缺省 normal。'),
    projectGroup: z.string().optional().describe('项目组名。指定目标项目时与 project 联用；项目名跨组重名时必须提供。'),
    project: z.string().optional().describe('项目名。list/create/update 指定目标项目时提供；不确定可用项目时先 list_projects。'),
}).superRefine((args, ctx) => {
    // 条件必填：update/delete 需要 id；create 需要 title 与 content
    if ((args.action === 'update' || args.action === 'delete') && !args.id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['id'],
            message: `${args.action} 操作需要提供 id，可先调用 list 获取`,
        })
    }
    if (args.action === 'create') {
        if (!args.title) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['title'],
                message: 'create 操作需要提供 title（标题）',
            })
        }
        if (!args.content) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['content'],
                message: 'create 操作需要提供 content（完整任务描述）',
            })
        }
    }
})

type MemoToolInput = z.infer<typeof inputSchema>

/** updatedAt → 可读时间 */
function formatTime(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN')
}

/** 单条备忘录 → 文本行（list 输出） */
function formatItem(item: MemoItem): string {
    return [
        `[${item.id}] ${item.title || '(无标题)'}`,
        `内容: ${item.content}`,
        `状态: ${item.status} | 优先级: ${item.priority || 'normal'} | 更新于: ${formatTime(item.updatedAt)}`,
    ].join('\n')
}

/**
 * 解析目标项目（仅在 project/projectGroup 至少给了一个时调用）。
 * 名称匹配口径见 memoProjectResolver：trim 后精确匹配，`__unassigned__` 不入清单。
 * 解析失败（未找到 / 歧义 / 只给组）返回 {ok:false, error}，由调用方转结构化错误，不抛异常。
 */
function resolveTarget(args: MemoToolInput): {ok: true; path: string; name: string} | {ok: false; error: string} {
    const entries = collectProjectEntries(workspaceRepo.list(), projectGroupRepo.list())
    const resolved = resolveTargetPath(entries, {projectGroup: args.projectGroup, project: args.project})
    if (!resolved.ok) return resolved
    // 展示名与项目清单同口径：按解析出的路径回查条目（path 必来自 entries，回查失败时退化为路径）
    const entry: ProjectEntry | undefined = entries.find(e => e.path === resolved.path)
    return {ok: true, path: resolved.path, name: entry?.name ?? resolved.path}
}

/** 解析目标项目或返回错误（project/projectGroup 均为空时返回 target: null） */
function resolveTargetOrError(args: MemoToolInput): {target: {path: string; name: string} | null, error?: string} {
    if (!args.project?.trim() && !args.projectGroup?.trim()) return {target: null}
    const target = resolveTarget(args)
    if (!target.ok) return {target: null, error: target.error}
    return {target: {path: target.path, name: target.name}}
}

export const memoTool: Tool<MemoToolInput, string> = {
    name: 'memo_tool',
    description: '备忘录管理。支持列出、创建、更新、删除备忘录。' +
        'title 是给人看的简短摘要；content 是完整任务描述，后续用户创建会话处理该备忘录时，' +
        'content 将直接作为 user 消息使用，因此需自包含全部背景与期望结果。' +
        '创建之前应先 list 去重，避免重复创建相同内容的备忘录。' +
        'priority 可选值 urgent/high/normal/low，根据内容自行判断，缺省 normal。' +
        '可用 list_projects 查看项目组与项目；用 projectGroup + project 指定目标项目（缺省落到当前工作目录）。' +
        '示例1（新建）：action=create, title="整理会议纪要", content="把2026-09-05产品评审会的录音转写并整理成纪要，输出到 docs/meeting/ 目录，重点标注待办事项与负责人。", priority="high"。' +
        '示例2（更新状态）：action=update, id=memo-xxxx, status=processed。' +
        '例如："记一条备忘录，下周提醒我整理周报" → action=create, title="整理周报", content="下周整理本周周报，包含进展、风险与下周计划。"。',
    inputSchema,
    requiredPermissions: [],
    // 不标记 isDestructive：create/list/update 需免确认（定时/无人值守场景），
    // 仅 delete 在 execute 内动态走 requestConfirmation 二次确认

    async execute(args: MemoToolInput, context: ToolContext): Promise<ToolResult<string>> {
        try {
            switch (args.action) {
                case 'list': {
                    const {target, error} = resolveTargetOrError(args)
                    if (error) return {success: false, output: '', error}
                    const items = memoStore.list(target ? target.path : context.workingDir)
                    if (items.length === 0) {
                        return {success: true, output: target ? `项目 ${target.name} 暂无备忘录。` : '当前工作区暂无备忘录。'}
                    }
                    const header = target ? `备忘录列表（项目：${target.name}）` : '备忘录列表'
                    return {
                        success: true,
                        output: `${header} (${items.length}):\n\n` + items.map(formatItem).join('\n\n')
                    }
                }

                case 'list_projects': {
                    const entries = collectProjectEntries(workspaceRepo.list(), projectGroupRepo.list())
                    return {success: true, output: formatProjectsText(entries)}
                }

                case 'create': {
                    if (!args.title?.trim()) {
                        return {success: false, output: '', error: 'create 操作需要提供 title（标题），且标题不能为空。'}
                    }
                    if (!args.content?.trim()) {
                        return {success: false, output: '', error: 'create 操作需要提供 content（完整任务描述），且内容不能为空。'}
                    }
                    const {target, error} = resolveTargetOrError(args)
                    if (error) return {success: false, output: '', error}
                    const workspacePath = target ? target.path : context.workingDir
                    const item = memoStore.create({
                        workspacePath,
                        title: args.title,
                        content: args.content,
                    })
                    // create 不支持 priority，传了则补写一次（不含目标项目，不会触发迁移）
                    const finalItem = args.priority
                        ? memoStore.update(item.id, {priority: args.priority})
                        : item
                    broadcastMemoChanged(workspacePath)
                    return {success: true, output: `✅ 备忘录已创建: ${finalItem.title} (ID: ${finalItem.id})`}
                }

                case 'update': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'update 操作需要提供 id。'}
                    }
                    const existing = memoStore.findById(args.id)
                    if (!existing) {
                        return {success: false, output: '', error: `未找到ID为 "${args.id}" 的备忘录。`}
                    }
                    const patch: Partial<Pick<MemoItem, 'title' | 'content' | 'status' | 'priority'>> & {targetWorkspacePath?: string} = {}
                    if (args.project?.trim() || args.projectGroup?.trim()) {
                        const target = resolveTarget(args)
                        if (!target.ok) {
                            return {success: false, output: '', error: target.error}
                        }
                        // 携带目标路径 = 跨项目迁移（memoStore 内部搬附件归档目录）
                        patch.targetWorkspacePath = target.path
                    }
                    if (args.title !== undefined) patch.title = args.title
                    if (args.content !== undefined) patch.content = args.content
                    if (args.status !== undefined) patch.status = args.status
                    if (args.priority !== undefined) patch.priority = args.priority
                    if (Object.keys(patch).length === 0) {
                        return {success: false, output: '', error: '请提供至少一个要更新的字段（title/content/status/priority）。'}
                    }
                    const updated = memoStore.update(args.id, patch)
                    // 归属可能变化：源与目标各广播一次（未迁移时两者同路径，只广播一次）
                    broadcastMemoChanged(existing.workspacePath)
                    if (updated.workspacePath !== existing.workspacePath) {
                        broadcastMemoChanged(updated.workspacePath)
                    }
                    return {success: true, output: `✅ 备忘录已更新: ${updated.title} (ID: ${updated.id})`}
                }

                case 'delete': {
                    if (!args.id) {
                        return {success: false, output: '', error: 'delete 操作需要提供 id。'}
                    }
                    const existing = memoStore.findById(args.id)
                    if (!existing) {
                        return {success: false, output: '', error: `未找到ID为 "${args.id}" 的备忘录。`}
                    }
                    // 破坏性操作：工具级免确认，仅在 delete 动态请求用户二次确认
                    if (context.requestConfirmation) {
                        const decision = await context.requestConfirmation(
                            `确定删除备忘录「${existing.title}」(ID: ${existing.id}) 吗？`
                        )
                        if (decision === 'deny') {
                            return {success: false, output: '', error: '用户拒绝删除该备忘录。'}
                        }
                    }
                    memoStore.remove(args.id)
                    broadcastMemoChanged(existing.workspacePath)
                    return {success: true, output: `✅ 备忘录已删除: ${existing.title} (ID: ${existing.id})`}
                }

                default:
                    return {success: false, output: '', error: `不支持的操作: ${args.action}`}
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            // 转成可行动的中文错误信息
            if (message === 'MEMO_EMPTY') return {success: false, output: '', error: '标题与内容不能为空，请补全后重试。'}
            if (message === 'MEMO_NOT_FOUND') return {success: false, output: '', error: '备忘录不存在，可先 list 确认 id。'}
            return {
                success: false,
                output: '',
                error: err instanceof Error ? err.message : '操作备忘录失败'
            }
        }
    },
}
