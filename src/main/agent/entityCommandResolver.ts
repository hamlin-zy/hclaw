/**
 * Entity Command Resolver — 跨线程共享的 skill/agent 命令解析
 *
 * 解决两个独立代码路径的重复逻辑：
 * - Agent Loop（Worker 线程）: detectCommandContext → lookupByName（只查 plugin/user 命令）
 * - IPC Handler（主进程）:    handleResolveByName → resolveEntityFallback（含 skill/agent 兜底）
 *
 * 抽取为单例模块后，两边直接 import 同一函数，消除不一致。
 * skillRegistry 和 agentRegistry 都是单例，Worker 线程中 import 安全（Worker 从主线程 fork，静态 import 复用已注册数据）。
 */

import {skillRegistry} from './skills'
import {buildSkillCommandTemplate} from './skills/guidance'
import {agentRegistry} from './agentRegistry'

/** 构建代理模式的命令模板 */
export function buildAgentCommandTemplate(agent: {
    name: string
    description?: string
    whenToUse?: string
    model?: string
    allowedTools?: string[]
    disallowedTools?: string[]
    permissionMode?: string
    systemPrompt: string
}): string {
    const fields = [
        ['描述', agent.description],
        ['适用场景', agent.whenToUse],
        ['模型', agent.model],
        ['可用工具', agent.allowedTools?.join(', ')],
        ['禁用工具', agent.disallowedTools?.join(', ')],
        ['权限模式', agent.permissionMode],
    ] as const

    const metaLines = fields
        .filter(([_, v]) => !!v)
        .map(([label, value]) => `${label}: ${value}`)

    return [
        `# 代理模式: ${agent.name}`,
        '',
        `你正在使用代理 "${agent.name}"。`,
        ...metaLines,
        '',
        agent.systemPrompt,
    ].join('\n')
}

/**
 * 在 skill/agent 注册表中按名称查找并构建命令模板
 * 用于命令解析的兜底逻辑（plugin/user 命令未命中时调用）
 */
export function resolveEntityCommand(name: string): {
    template: string
    commandId: string
} | null {
    const skill = skillRegistry.find(name)
    if (skill?.enabled) {
        return {
            template: buildSkillCommandTemplate(skill),
            commandId: `skill:${skill.id}`,
        }
    }

    const agent = agentRegistry.find(name)
    if (agent?.enabled) {
        return {
            template: buildAgentCommandTemplate(agent),
            commandId: `agent:${agent.id}`,
        }
    }

    return null
}
