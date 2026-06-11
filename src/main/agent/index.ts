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
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {logger} from './logger'

import {registerHandlers as registerAgentHandlers} from './ipc/agents'
import {registerHandlers as registerExecutionHandlers} from './ipc/execution'
import {registerHandlers as registerPermissionHandlers} from './ipc/permissions'
import {registerHandlers as registerSkillHandlers} from './ipc/skills'
import {registerHandlers as registerConfigHandlers} from './ipc/config'
import {registerHandlers as registerSystemPromptHandlers} from './ipc/system-prompt'
import {registerHandlers as registerToolHandlers} from './ipc/tools'

/** 初始化 Agent 系统（在 app.ready 时调用） */
export async function initAgent(): Promise<void> {
    // 注册内置工具
    registerBuiltinTools()

    // 注意：MCP IPC handlers 在 index.ts 的 app.on('ready') 中注册
    // 因为需要在 createWindow() 之前初始化，以确保渲染进程 rehydration 可以正常获取数据

    // 默认开启 safe 模式：破坏性工具需确认
    await permissionEngine.setMode('safe')

    // 从持久化存储恢复工作模式
    try {
        const savedWorkMode = systemSettingsRepo.get('work_mode') as string | null
        if (savedWorkMode) {
            runtimeConfigManager.setWorkMode(savedWorkMode)
        }
    } catch (err) {
        // 首次启动无保存值，使用默认 'work'
    }

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
    registerPermissionHandlers()
    registerSkillHandlers()
    registerConfigHandlers()
    registerSystemPromptHandlers()
    registerToolHandlers()
}

export {agentManager}
