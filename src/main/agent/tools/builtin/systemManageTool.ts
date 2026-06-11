/**
 * system_manage 工具 — HClaw 系统管理
 *
 * 支持：获取系统配置、更新配置项、重启应用。
 * 通过 action 参数区分操作类型。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import type {SystemSettings} from '@shared/types'
import {systemSettingsRepo} from '../../../repositories/sqlite/systemSettingsRepository'

const themeSchema = z.enum(['light', 'dark', 'yuanshandai', 'shiyangjin', 'system']).optional()

const inputSchema = z.object({
    action: z.enum(['get_settings', 'update_settings', 'restart'])
        .describe('操作类型：get_settings=获取当前系统配置 | update_settings=更新配置项（增量合并） | restart=重启 HClaw 应用'),

    // ── update_settings 时的字段 ──
    settings: z.object({
        ui: z.object({
            theme: themeSchema.describe('UI 主题。light=明亮 | dark=暗黑 | yuanshandai=远山黛 | shiyangjin=十样锦 | system=跟随系统'),
            language: z.string().optional().describe('界面语言，如 zh-CN、en-US'),
        }).optional(),
        agent: z.object({
            maxTurns: z.number().optional().describe('Agent 推理循环的最大迭代次数'),
            retryCount: z.number().optional().describe('LLM 超时或异常时的自动重试次数'),
            initialRetryDelay: z.number().optional().describe('首次重试延迟（毫秒）'),
            maxRetryDelay: z.number().optional().describe('最大重试延迟（毫秒）'),
            llmTimeout: z.number().optional().describe('LLM 请求超时（毫秒）'),
            compactThreshold: z.number().optional().describe('自动压缩阈值（token 数）'),
        }).optional(),
        model: z.object({
            defaultMaxTokens: z.number().optional().describe('默认最大输出 token 数'),
            defaultTemperature: z.number().optional().describe('默认采样温度 (0-2)'),
        }).optional(),
        mcp: z.object({
            mcpTestTimeout: z.number().optional().describe('MCP 连接测试超时（毫秒）'),
        }).optional(),
        subagent: z.object({
            maxConcurrency: z.number().optional().describe('最大并发子任务数'),
            defaultTimeout: z.number().optional().describe('子任务默认超时（毫秒）'),
            retryAttempts: z.number().optional().describe('子任务重试次数'),
            priorityEnabled: z.boolean().optional().describe('是否启用优先级调度'),
        }).optional(),
    }).optional().describe('update_settings 时的配置项（增量合并，只需提供要修改的字段）'),
})

type SystemManageInput = z.infer<typeof inputSchema>

export const systemManageTool: Tool<SystemManageInput, string> = {
    name: 'system_manage',
    description: 'HClaw 系统管理。支持获取当前系统配置、更新指定配置项（如主题、模型参数、超时等）、以及重启应用。' +
        '通过 action 参数区分操作。' +
        '示例：获取当前配置 → action=get_settings；切换暗色主题 → action=update_settings, settings={ui:{theme:"dark"}}。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: SystemManageInput, _context: ToolContext): Promise<ToolResult<string>> {
        try {
            switch (args.action) {
                case 'get_settings': {
                    const all = systemSettingsRepo.getAll()
                    const raw = all['settings']
                    if (!raw) {
                        return {success: true, output: '未找到系统配置。请先保存配置后再查询。'}
                    }
                    try {
                        const parsed = JSON.parse(raw)
                        const lines: string[] = []
                        lines.push('=== UI 配置 ===')
                        lines.push(`  主题: ${parsed.ui?.theme || '未知'}`)
                        lines.push(`  语言: ${parsed.ui?.language || '未知'}`)
                        lines.push('')
                        lines.push('=== Agent 配置 ===')
                        lines.push(`  最大轮次: ${parsed.agent?.maxTurns ?? '-'}`)
                        lines.push(`  重试次数: ${parsed.agent?.retryCount ?? '-'}`)
                        lines.push(`  首次重试延迟: ${parsed.agent?.initialRetryDelay ?? '-'}ms`)
                        lines.push(`  最大重试延迟: ${parsed.agent?.maxRetryDelay ?? '-'}ms`)
                        lines.push(`  LLM 超时: ${parsed.agent?.llmTimeout ?? '-'}ms`)
                        lines.push(`  压缩阈值: ${parsed.agent?.compactThreshold ?? '-'} tokens`)
                        lines.push('')
                        lines.push('=== 模型配置 ===')
                        lines.push(`  默认 MaxTokens: ${parsed.model?.defaultMaxTokens ?? '-'}`)
                        lines.push(`  默认 Temperature: ${parsed.model?.defaultTemperature ?? '-'}`)
                        lines.push('')
                        lines.push('=== 子任务配置 ===')
                        lines.push(`  最大并发: ${parsed.subagent?.maxConcurrency ?? '-'}`)
                        lines.push(`  默认超时: ${parsed.subagent?.defaultTimeout ?? '-'}ms`)
                        lines.push(`  重试次数: ${parsed.subagent?.retryAttempts ?? '-'}`)
                        lines.push(`  优先级调度: ${parsed.subagent?.priorityEnabled ? '启用' : '禁用'}`)
                        lines.push('')
                        return {success: true, output: lines.join('\n')}
                    } catch {
                        return {success: true, output: `系统配置(原始):\n${raw.slice(0, 2000)}`}
                    }
                }

                case 'update_settings': {
                    if (!args.settings || Object.keys(args.settings).length === 0) {
                        return {success: false, output: '', error: 'update_settings 需要提供至少一个配置项。'}
                    }

                    // 读取现有配置
                    const raw = systemSettingsRepo.get('settings')
                    const current: Partial<SystemSettings> = raw ? JSON.parse(raw) : {}

                    // 增量合并
                    const merged: Record<string, any> = {...current}
                    for (const [category, values] of Object.entries(args.settings)) {
                        if (values && typeof values === 'object') {
                            merged[category] = {...(merged[category] || {}), ...values}
                        }
                    }

                    const ok = systemSettingsRepo.setJson('settings', merged)
                    if (!ok) {
                        return {success: false, output: '', error: '保存配置失败。'}
                    }

                    // 通知渲染进程刷新设置（通过 _context.onEvent 经主进程 router 转发）
                    // 注意：Worker 线程不能直接 require window 模块，必须通过 onEvent 通信
                    if (_context?.onEvent) {
                        _context.onEvent({type: 'settings-updated', settings: merged})
                    }

                    return {success: true, output: '✅ 系统配置已更新。'}
                }

                case 'restart': {
                    // 通过 onEvent 通知主进程执行重启（Worker 线程不能直接 require electron）
                    if (_context?.onEvent) {
                        _context.onEvent({type: 'app-restart'})
                    }
                    return {success: true, output: '正在重启 HClaw...'}
                }

                default:
                    return {success: false, output: '', error: `不支持的操作: ${args.action}`}
            }
        } catch (err) {
            return {
                success: false,
                output: '',
                error: err instanceof Error ? err.message : '系统管理操作失败'
            }
        }
    },
}
