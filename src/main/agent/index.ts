/**
 * Agent 模块入口 — IPC 注册 + Worker 管理
 *
 * 对外暴露：
 * - initAgent(): 注册内置工具 + IPC handlers
 * - registerAgentIPC(): 注册所有 IPC handler
 * - agentManager: 全局 AgentManager 实例
 */

import {agentManager} from './manager'
import {registerBuiltinTools} from './tools/index'
import {permissionEngine} from './tools/permission'
import {powerManager} from './powerManager'
import {runtimeConfigManager} from './runtimeConfigManager'

import {registerHandlers as registerAgentHandlers} from './ipc/agents'
import {registerHandlers as registerExecutionHandlers} from './ipc/execution'
import {registerHandlers as registerContextUsageHandlers} from './ipc/contextUsage'
import {registerHandlers as registerPermissionHandlers} from './ipc/permissions'
import {registerHandlers as registerSkillHandlers} from './ipc/skills'
import {registerHandlers as registerConfigHandlers} from './ipc/config'
import {registerHandlers as registerSystemPromptHandlers} from './ipc/system-prompt'
import {registerHandlers as registerToolHandlers} from './ipc/tools'

/** 初始化 Agent 系统（在 app.ready 时调用） */
export async function initAgent(): Promise<void> {
    // 启动时从 system_settings 恢复 lastSelected override（新建会话继承上次手动选择）
    runtimeConfigManager.initOverrideState()

    // 注册内置工具
    registerBuiltinTools()

    // 注意：MCP IPC handlers 在 index.ts 的 app.on('ready') 中注册
    // 因为需要在 createWindow() 之前初始化，以确保渲染进程 rehydration 可以正常获取数据

    // 默认开启 safe 模式：破坏性工具需确认
    await permissionEngine.setMode('safe')

    // 使用 PowerManager 统一初始化所有能力（MCP、Skills、Agents）
    // CRITICAL: 必须等待初始化完成，否则插件技能无法正确加载
    try {
        await powerManager.initialize()
    } catch (err) {
        throw err
    }
}

/**
 * 注册 Agent 相关 IPC 处理器
 *
 * 必须在 app.on('ready') 之前调用，确保渲染进程加载时 handler 已就绪
 */
export function registerAgentIPC(): void {
    registerAgentHandlers()
    registerExecutionHandlers()
    registerContextUsageHandlers()
    registerPermissionHandlers()
    registerSkillHandlers()
    registerConfigHandlers()
    registerSystemPromptHandlers()
    registerToolHandlers()
}

export {agentManager}
