/**
 * Agent 类型配置注册表
 *
 * 支持动态注册新的 Agent 类型配置，不再局限于 4 种内置类型。
 * 内置的 4 种 Agent 类型在模块初始化时自动注册。
 *
 * @see registerAgentTypeConfig
 * @see getAgentTypeConfig
 */

import type {AgentTypeConfig} from '@shared/types'
import type {ToolDefinitionForLLM} from '../tools/types'

// ─── 内置 Agent 类型配置 ────────────────────────────────────────

const BUILTIN_CONFIGS: AgentTypeConfig[] = [
    {
        type: 'Plan',
        whenToUse: '架构规划、只读分析、任务分解',
        disallowedTools: [
            'Write',
            'Edit',
            'Bash',
            'NotebookEdit',
            'TaskWrite',
            'Agent',
        ],
        defaultModelRole: 'reasoning',
        optimizations: {
            omitClaudeMd: true,
            omitGitStatus: true,
        },
    },
    {
        type: 'Explore',
        whenToUse: '快速代码搜索、只读探索、文件查找',
        disallowedTools: [
            'Write',
            'Edit',
            'Bash',
            'NotebookEdit',
            'TaskWrite',
            'Agent',
        ],
        defaultModelRole: 'lightweight',
        optimizations: {
            omitClaudeMd: true,
            omitGitStatus: true,
        },
    },
    {
        type: 'Verification',
        whenToUse: '验证实现、试图打破代码、测试验证',
        disallowedTools: [
            'Write',
            'Edit',
            'NotebookEdit',
            'Agent',
        ],
        defaultModelRole: 'inherit',
        optimizations: {},
    },
    {
        type: 'General',
        whenToUse: '通用任务执行、工具调用、代码修改',
        allowedTools: ['*'],
        defaultModelRole: 'primary',
        optimizations: {},
    },
]

// ─── 注册表 ──────────────────────────────────────────────────────

const configRegistry = new Map<string, AgentTypeConfig>()

/**
 * 注册 Agent 类型配置
 * 允许动态添加新的 Agent 类型
 *
 * @param config Agent 类型配置
 */
export function registerAgentTypeConfig(config: AgentTypeConfig): void {
    configRegistry.set(config.type, config)
}

/**
 * 获取 Agent 类型配置
 * 如果未找到该类型的注册配置，返回 General 类型配置作为兜底
 *
 * @param type Agent 类型
 * @returns Agent 类型配置
 */
export function getAgentTypeConfig(type: string): AgentTypeConfig {
    return configRegistry.get(type) ?? configRegistry.get('General')!
}

/**
 * 获取所有已注册的 Agent 类型配置
 */
export function getAllAgentTypeConfigs(): AgentTypeConfig[] {
    return Array.from(configRegistry.values())
}

/**
 * 获取 Agent 类型的工具限制
 */
export function getAgentToolRestrictions(type: string): {
    allowed?: string[]
    disallowed?: string[]
} {
    const config = getAgentTypeConfig(type)
    return {
        allowed: config.allowedTools,
        disallowed: config.disallowedTools,
    }
}

/**
 * 获取 Agent 类型的 Token 优化配置
 */
export function getAgentOptimizations(type: string): {
    omitClaudeMd: boolean
    omitGitStatus: boolean
} {
    const config = getAgentTypeConfig(type)
    return {
        omitClaudeMd: config.optimizations?.omitClaudeMd ?? false,
        omitGitStatus: config.optimizations?.omitGitStatus ?? false,
    }
}

/**
 * Agent 类型显示信息
 */
export interface AgentTypeDisplayInfo {
    name: string
    description: string
    icon: string
}

/**
 * 获取 Agent 类型的显示信息
 * 支持任意字符串类型的 Agent 名称
 */
export function getAgentTypeDisplayInfo(type: string): AgentTypeDisplayInfo {
    switch (type) {
        case 'Plan':
            return {
                name: 'Plan',
                description: '架构规划 · 只读分析 · 任务分解',
                icon: '📋',
            }
        case 'Explore':
            return {
                name: 'Explore',
                description: '快速搜索 · 只读探索 · 文件查找',
                icon: '🔍',
            }
        case 'Verification':
            return {
                name: 'Verification',
                description: '验证实现 · 打破代码 · 测试检查',
                icon: '✅',
            }
        case 'General':
        default:
            return {
                name: 'General',
                description: '通用执行 · 工具调用 · 代码修改',
                icon: '⚙️',
            }
    }
}

/**
 * 获取所有 Agent 类型的显示信息列表
 */
export function getAllAgentTypeDisplayInfos(): AgentTypeDisplayInfo[] {
    return getAllAgentTypeConfigs().map(cfg => getAgentTypeDisplayInfo(cfg.type))
}

// ─── 初始化：注册内置 Agent 类型 ────────────────────────────────

for (const config of BUILTIN_CONFIGS) {
    registerAgentTypeConfig(config)
}

/**
 * 根据 Agent 类型过滤工具列表
 */
export function filterToolsByAgentType(
    tools: ToolDefinitionForLLM[],
    restrictions: { allowed?: string[]; disallowed?: string[] },
): ToolDefinitionForLLM[] {
    const {allowed, disallowed} = restrictions

    // 如果允许所有工具且没有禁用列表，返回全部
    if (allowed === undefined && (disallowed === undefined || disallowed.length === 0)) {
        return tools
    }

    return tools.filter((tool) => {
        const toolName = tool.name

        // 检查是否在禁用列表中
        if (disallowed && disallowed.includes(toolName)) {
            return false
        }

        // 如果有允许列表，检查是否在列表中
        // allowed === ['*'] 表示允许所有工具
        if (allowed && !(allowed.length === 1 && allowed[0] === '*') && !allowed.includes(toolName)) {
            return false
        }

        return true
    })
}
