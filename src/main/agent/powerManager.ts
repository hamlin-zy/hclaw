/**
 * PowerManager - 统一能力管理器（重构版本）
 *
 * 职责：
 * 1. 统一管理 Agent、Skill、MCP 三种能力
 * 2. 提供统一的初始化和刷新入口
 * 3. 响应插件状态变更事件
 * 4. 提供能力查询接口
 *
 * 优化：
 * - 使用事件总线解耦插件管理和能力管理
 * - 依赖 ICapabilityRegistry 接口，不依赖具体实现
 * - 消除 initialize() 和 refresh() 的重复代码
 */

import {agentRegistry} from './agentRegistry'
import {loadSkillsFromDirectory, loadSkillsFromPluginDirectory, loadSkillsFromPlugins, skillRegistry, applySkillOverrides} from './skills'
import {scanAgentsFromPlugin, scanAllAgents} from './agentLoader'
import {mcpService} from '../services/mcpService'
import type {MCPServerState} from './mcp/types'
import type {McpServer} from '../../shared/types/mcp'
import {getMcpPluginOverride, mergePluginOverride, setMcpPluginOverride} from '../config/mcpConfig'
import type {PluginMcpOverride} from '../config/mcpConfig'
import {loadMcpServersFromPlugin} from './mcp/bootstrap'
import {eventBus, MCPThemeEvents, PluginEvents} from '../common/eventBus'
import {capabilityMapper} from '../common/capabilityMapper'
import {PluginRegistry} from '../plugin/registry'
import {CommandDispatcher} from '../plugin/commands'
import {capabilityHub} from '../capability/CapabilityHub'
import type {CapabilityEntry} from '../capability/types'
import type {AgentTemplate} from '@shared/types'
import type {SkillDefinition} from './skills/types'
import {logger} from './logger'

export interface EnabledPower {
    agents: AgentTemplate[]
    skills: SkillDefinition[]
    mcps: MCPServerState[]
}

class PowerManagerImpl {
    private initialized = false
    /** 执行队列 - 确保串行执行，防止并发 */
    private executionQueue: Promise<void> = Promise.resolve()
    /** 防抖定时器 ID */
    private refreshDebounceTimer: NodeJS.Timeout | null = null
    /** 防抖延迟（毫秒）- 事件密集触发时合并多次刷新 */
    private readonly REFRESH_DEBOUNCE_MS = 100

    /** 确保后续操作串行执行 */
    private async serialized<T>(fn: () => Promise<T>): Promise<T> {
        const prev = this.executionQueue
        let result!: T
        this.executionQueue = prev.then(() => fn()).then(r => {
            result = r
        })
        await this.executionQueue
        return result
    }

    constructor() {
        // Subscribe to plugin events
        this.setupEventListeners()
    }

    /**
     * 设置事件监听器
     * 注意：事件处理器不等待刷新完成，刷新在后台进行
     * 重要：启动初始化期间（initialized=false）忽略事件，避免重复刷新
     */
    private setupEventListeners(): void {
        // 插件启用事件 - 局部刷新该插件的能力
        eventBus.on(PluginEvents.ENABLED, (pluginName: string) => {
            if (!this.initialized) return // 启动期间忽略，initialize() 会统一加载
            logger.debug('plugin-enabled', {pluginName})
            capabilityHub.onPluginStateChange(pluginName, true)
            this.refreshPlugin(pluginName, true)
        })

        // 插件禁用事件 - 同步禁用状态（不调用 removePluginCapabilities，那是卸载用的）
        // handleDisable 会触发 powerManager.refresh() 做全量重载，这里仅做轻量同步
        eventBus.on(PluginEvents.DISABLED, (pluginName: string) => {
            if (!this.initialized) return // 启动期间忽略，initialize() 会统一加载
            logger.debug('plugin-disabled', {pluginName})
            // 轻量同步：仅更新内存中的启用状态，不清除注册表
            skillRegistry.syncPluginStatus(pluginName, false)
            agentRegistry.syncPluginStatus(pluginName, false)
            capabilityHub.onPluginStateChange(pluginName, false)
            // Commands: CommandDispatcher.getAllCommands() 在查询时按插件启用状态过滤
            // 清除该插件的 commandCache（下次 query 时从 PluginRegistry 重读并过滤）
            const commandDispatcher = CommandDispatcher.getInstance()
            commandDispatcher.unregisterByPlugin(pluginName)
        })

        // 插件安装事件 - 触发后台刷新（全量，因为可能有新插件）
        eventBus.on(PluginEvents.INSTALLED, (pluginPath: string) => {
            if (!this.initialized) return // 启动期间忽略，initialize() 会统一加载
            logger.debug('plugin-installed', {pluginPath})
            this.scheduleRefresh()
        })

        // 插件卸载事件 - 移除该插件的能力
        eventBus.on(PluginEvents.UNINSTALLED, (pluginName: string) => {
            if (!this.initialized) return // 启动期间忽略，initialize() 会统一加载
            logger.debug('plugin-uninstalled', {pluginName})
            this.removePluginCapabilities(pluginName)
        })
    }

    /**
     * 初始化所有能力
     * @param pluginEnabledMap Worker 中需要传入插件启用状态
     */
    async initialize(pluginEnabledMap?: Record<string, boolean>): Promise<void> {
        if (this.initialized) return
        await this.serialized(async () => {
            if (this.initialized) return  // 双重检查，防止 await 期间被初始化
            try {
                await this.loadAllCapabilities(pluginEnabledMap)
                this.initialized = true
                const stats = await this.getStats()
                logger.debug('initialize', {success: true, stats})
            } catch (error) {
                logger.error('initialize', {success: false, error: String(error)})
                throw error
            }
        })
    }

    /**
     * 安排一次刷新（带防抖）
     * 事件响应，不需要返回结果，只触发一次即可
     */
    private scheduleRefresh(): void {
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer)
        }
        this.refreshDebounceTimer = setTimeout(() => {
            this.refreshDebounceTimer = null
            this.refresh()  // serialized 保证串行
        }, this.REFRESH_DEBOUNCE_MS)
    }

    /**
     * 重置初始化状态，下次 getAllEnabledPower 时重新加载
     */
    resetInitialized(): void {
        this.initialized = false
    }

    /**
     * 刷新所有能力（响应插件状态变更）
     * 使用 serialized 队列防止并发重复刷新
     */
    async refresh(): Promise<void> {
        await this.serialized(async () => {
            logger.debug('refresh', {status: 'starting'})
            try {
                capabilityMapper.clear()
                await this.loadAllCapabilities()
                this.syncToCapabilityHub()
                const stats = await this.getStats()
                logger.debug('refresh', {status: 'completed', stats})
            } catch (error) {
                logger.error('refresh', {status: 'failed', error: String(error)})
            }
        })
    }

    /**
     * 局部刷新指定插件的能力
     * 启用时：增量加载该插件的 Agents、Skills、MCPs
     * 禁用时：只移除该插件的能力（不清空全部）
     *
     * @param pluginName 插件名称
     * @param enabled     true=加载，false=移除
     * @param reload      true=先卸载再加载（增量刷新），false=仅加载不卸载
     */
    async refreshPlugin(pluginName: string, enabled: boolean, reload = false): Promise<void> {
        logger.debug('refreshPlugin', {pluginName, enabled, reload, status: 'starting'})
        try {
            if (enabled && reload) {
                this.removePluginCapabilities(pluginName)
            }
            if (enabled) {
                await Promise.all([
                    this.loadAgentsFromPlugin(pluginName),
                    this.loadSkillsFromPlugin(pluginName),
                    this.loadMcpServersFromPlugin(pluginName),
                    await CommandDispatcher.getInstance().refresh(),
                ])
            } else {
                this.removePluginCapabilities(pluginName)
            }
            logger.debug('refreshPlugin', {pluginName, enabled, status: 'completed'})
        } catch (error) {
            logger.error('refreshPlugin', {pluginName, enabled, status: 'failed', error: String(error)})
        }
    }

    /**
     * 移除指定插件的所有能力
     */
    private removePluginCapabilities(pluginName: string): void {
        // 移除该插件的 Agents
        const removedAgents = agentRegistry.unregisterByPlugin(pluginName)
        logger.debug('removePluginCapabilities', {pluginName, type: 'agents', count: removedAgents})

        // 移除该插件的 Skills
        const removedSkills = skillRegistry.unregisterByPlugin(pluginName)
        logger.debug('removePluginCapabilities', {pluginName, type: 'skills', count: removedSkills})

        // 移除该插件的 MCP 连接（通过 MCP Worker Manager 通知）
        // Phase 2: MCP Worker 管理所有连接，主进程不再直接操作 mcpClient
        logger.debug('removePluginCapabilities', {pluginName, type: 'mcps', note: 'handled-by-mcp-worker'})

        // 移除该插件的 Commands
        const commandDispatcher = CommandDispatcher.getInstance()
        commandDispatcher.unregisterByPlugin(pluginName)
        logger.debug('removePluginCapabilities', {pluginName, type: 'commands'})

        // 从能力映射器移除
        capabilityMapper.removePlugin(pluginName)
    }

    /**
     * 从指定插件加载 Agents
     */
    private async loadAgentsFromPlugin(pluginName: string): Promise<void> {
        try {
            const { templates } = await scanAgentsFromPlugin(pluginName)
            for (const template of templates) {
                capabilityMapper.trackCapability(pluginName, template.id)
                agentRegistry.register(template)
            }
            logger.debug('loadAgentsFromPlugin', {pluginName, count: templates.length})
        } catch (error) {
            logger.error('loadAgentsFromPlugin', {pluginName, error: String(error)})
        }
    }

    /**
     * 从指定插件加载 Skills
     */
    private async loadSkillsFromPlugin(pluginName: string): Promise<void> {
        try {
            const count = await loadSkillsFromPluginDirectory(pluginName)
            // 重新注册到能力映射器（loadSkillsFromPluginDirectory 已注册到 skillRegistry）
            const pluginSkills = skillRegistry.getAll().filter(s => s.pluginName === pluginName)
            for (const skill of pluginSkills) {
                capabilityMapper.trackCapability(pluginName, skill.id)
            }
            logger.debug('loadSkillsFromPlugin', {pluginName, count})
        } catch (error) {
            logger.error('loadSkillsFromPlugin', {pluginName, error: String(error)})
        }
    }

    /**
     * 从指定插件加载 MCP 服务器
     *
     * 原则：
     * 1. ALL 插件 MCP 都加入 mcpService 缓存（含禁用），让 UI 始终可显示
     * 2. 仅 enabled 的服务器才尝试连接
     * 3. 失败不重试（除非用户手动操作），用已有错误状态显示
     * 4. 串行连接：一个失败不影响其他
     */
    private async loadMcpServersFromPlugin(pluginName: string): Promise<void> {
        try {
            const servers = loadMcpServersFromPlugin(pluginName)

            for (const server of servers) {
                const serverId = server.id as string
                capabilityMapper.trackCapability(pluginName, serverId)

                // 获取用户覆盖配置（在 UI 中编辑过的字段）
                const override = getMcpPluginOverride(serverId)
                const isEnabled = override?.enabled ?? true
                const merged = mergePluginOverride(server, override)

                // 加入缓存让 UI 立即显示，禁用状态也加入（连接由 MCP Worker 处理）
                mcpService.addPluginServer(isEnabled ? merged : {...merged, enabled: false})

                // 缓存完整配置到 mcp.json（供下次启动跳过插件目录扫描）
                this.cachePluginMcpToJson(serverId, merged, override)
            }

            if (servers.length > 0) {
                eventBus.emit(MCPThemeEvents.TOOLS_REFRESHED, {pluginName, count: servers.length})
            }
        } catch (error) {
            logger.error('loadMcpServersFromPlugin', {pluginName, error: String(error)})
        }
    }

    /**
     * 将插件 MCP 完整配置回写到 mcp.json 的 pluginMcpServers
     *
     * 目的：启动阶段可仅依赖 mcp.json 作为单一数据源，
     * 避免每次启动都必须扫描插件目录来获取 command/args/url 等启动参数。
     *
     * 仅当现有 override 不完整时写入（缺 command 且缺 url），
     * 避免覆盖用户通过 UI 手动编辑过的完整配置。
     */
    private cachePluginMcpToJson(
        serverId: string,
        merged: McpServer,
        existingOverride: PluginMcpOverride | null
    ): void {
        if (existingOverride && (existingOverride.command || existingOverride.url)) {
            return  // 已有完整配置，不覆盖
        }
        try {
            setMcpPluginOverride(serverId, {
                enabled: merged.enabled,
                name: merged.name,
                command: merged.command || '',
                args: merged.args || [],
                env: merged.env || {},
                url: merged.url || '',
                headers: merged.headers || {},
                cwd: merged.cwd || '',
                transport: merged.transport,
                timeout: merged.timeout,
                autoApprove: merged.autoApprove,
                denyList: merged.denyList,
                userDescription: merged.userDescription || '',
            })
        } catch { /* 写入失败不影响主流程 */ }
    }

    /**
     * 统一加载所有能力（并行加载）
     * 消除 initialize() 和 refresh() 的重复代码
     */
    private async loadAllCapabilities(pluginEnabledMap?: Record<string, boolean>): Promise<void> {
        // 并行加载所有能力
        await Promise.all([
            this.loadAgents(),
            this.loadSkills(pluginEnabledMap),
            this.loadMcpServers(),
            this.loadCommands()
        ])
    }

    /**
     * 加载所有 Agents
     */
    private async loadAgents(): Promise<void> {
        // 清空注册表
        agentRegistry.clear()

        // 扫描所有 Agents（本地 + 插件）
        const agentTemplates = await scanAllAgents()

        // 注册所有 Agents
        for (const template of agentTemplates) {
            // 提取插件名称（如果是插件 Agent）
            const pluginName = this.extractPluginName(template.id)
            capabilityMapper.trackCapability(pluginName, template.id)

            agentRegistry.register(template)
        }
    }

    /**
     * 加载所有 Skills
     */
    private async loadSkills(pluginEnabledMap?: Record<string, boolean>): Promise<void> {
        // 清空注册表
        skillRegistry.clear()

        // 加载本地 Skills
        await loadSkillsFromDirectory()

        // 加载插件 Skills
        await loadSkillsFromPlugins()

        // Worker 线程中：同步插件 Skills 启用状态
        if (pluginEnabledMap) {
            this.syncPluginSkillsEnabled(pluginEnabledMap)
        }

        // 应用 skill_overrides 覆盖（优先级高于文件中的 enabled 字段）
        applySkillOverrides()

        // 注册技能到能力映射器
        const allSkills = skillRegistry.getAll()
        for (const skill of allSkills) {
            capabilityMapper.trackCapability(skill.pluginName, skill.id)
        }
    }

    /**
     * 加载 MCP 服务器配置到缓存
     *
     * Phase 2: 连接由 MCP Worker 管理，此处仅加载配置不建立连接。
     */
    private async loadMcpServers(): Promise<void> {
        // 加载插件 MCP 配置到缓存（只注册配置，不连接）
        // 注意：必须有 await！refreshPlugin → loadMcpServersFromPlugin
        // → mcpService.addPluginServer 是异步的，如果不 await，
        // mcpWorkerManager.init() 抢跑读取时会看不到插件服务器
        await Promise.all(
            PluginRegistry.getInstance().getEnabled().map(
                plugin => this.refreshPlugin(plugin.name, true, true)
                    .catch(err => logger.error('plugin-mcp-config-bg', {pluginName: plugin.name, error: String(err)}))
            )
        )

        // 注册 MCP 服务器到能力映射器
        for (const server of mcpService.list()) {
            const serverId = server.id
            if (serverId) {
                capabilityMapper.trackCapability(this.extractPluginName(serverId), serverId)
            }
        }
    }

    /**
     * 加载所有命令，并将每个命令注册为 Agent（供 LLM 通过 agent 工具自主调度）
     */
    private async loadCommands(): Promise<void> {
        // 加载命令
        await CommandDispatcher.getInstance().refresh()

        // 将命令注册为 AgentTemplate（供 agent 工具降级查找）
        this.registerCommandsAsAgents()
    }

    /**
     * 将启用的命令注册到 agentRegistry，使 LLM 可自主调度命令
     * user 命令优先，plugin 命令自动去重
     */
    private registerCommandsAsAgents(): void {
        const dispatcher = CommandDispatcher.getInstance()
        const {pluginGroups, userCommands} = dispatcher.getAllCommands()
        const now = Date.now()
        const seen = new Set<string>()

        // user 命令优先注册
        for (const cmd of userCommands) {
            if (cmd.enabled === false) continue
            const cmdName = cmd.name || cmd.id
            if (!cmdName || !cmd.content) continue
            const key = cmd.id
            if (seen.has(key)) continue
            seen.add(key)
            agentRegistry.register({
                id: `cmd:${cmd.id}`,
                name: cmdName,
                description: cmd.description || cmdName,
                userDescription: cmd.description || cmdName,
                whenToUse: cmd.description || undefined,
                systemPrompt: cmd.content,
                enabled: true,
                createdAt: now,
                updatedAt: now,
            })
        }

        // plugin 命令（未被 user 覆盖的才注册）
        for (const [, commands] of pluginGroups) {
            for (const cmd of commands) {
                const cmdName = cmd.name || cmd.id.split(':').pop() || cmd.id
                if (!cmdName || !cmd.content) continue
                const key = cmd.id
                if (seen.has(key)) continue
                seen.add(key)
                agentRegistry.register({
                    id: `cmd:${cmd.id}`,
                    name: cmdName,
                    description: cmd.description || cmdName,
                    userDescription: cmd.description || cmdName,
                    whenToUse: cmd.description || undefined,
                    systemPrompt: cmd.content,
                    enabled: true,
                    createdAt: now,
                    updatedAt: now,
                })
            }
        }
    }

    /**
     * 同步插件技能启用状态（Worker 线程使用）
     */
    private syncPluginSkillsEnabled(pluginEnabledMap: Record<string, boolean>): void {
        const pluginSkills = skillRegistry.getAll().filter(s => !!s.pluginName)
        let synced = 0

        for (const skill of pluginSkills) {
            const pluginEnabled = pluginEnabledMap[skill.pluginName!]
            if (pluginEnabled === undefined) {
                skill.enabled = false
            } else {
                skill.enabled = pluginEnabled
                if (pluginEnabled) synced++
            }
        }
    }

    /**
     * 获取所有启用的能力
     * 直接从注册表返回最新数据，无锁高性能
     * 如果未初始化，先执行同步初始化
     */
    async getAllEnabledPower(): Promise<EnabledPower> {
        // 如果未初始化，先同步初始化
        if (!this.initialized) {
            await this.initialize()
        }

        // 直接从注册表返回最新数据（过滤掉 cmd: 前缀的内部条目）
        const enabledAgents = agentRegistry.getEnabled().filter(a => !a.id.startsWith('cmd:'))
        const enabledSkills = skillRegistry.getEnabled()
        // MCP 能力计数：通过 mcpService 获取（MCP Worker 状态已同步到缓存）
        const mcpList = mcpService.list()
        const connectedMcps = mcpList.filter(s => s.status === 'connected' || s.status === 'connecting')

        const result: EnabledPower = {
            agents: enabledAgents,
            skills: enabledSkills,
            mcps: connectedMcps as unknown as MCPServerState[],
        }

        // 记录日志
        logger.debug('[PowerManager] getAllEnabledPower', {
            agents: enabledAgents.length,
            skills: enabledSkills.length,
            mcps: connectedMcps.length,
        })

        return result
    }

    /**
     * 兼容旧版本 API（拼写错误保留）
     */
    async getAllEanbelPower(): Promise<EnabledPower> {
        return this.getAllEnabledPower()
    }

    /**
     * 获取统计信息
     */
    async getStats(): Promise<{ agents: number; skills: number; mcps: number }> {
        const mcpList = mcpService.list()
        const connectedMcpCount = mcpList.filter(s => s.status === 'connected').length

        const stats = {
            agents: agentRegistry.getEnabled().length,
            skills: skillRegistry.getEnabled().length,
            mcps: connectedMcpCount,
        }
        return stats
    }

    /**
     * 将当前所有能力同步到 CapabilityHub（统一查询中心）
     *
     * 在 refresh() 完成后调用，确保 Hub 数据与注册表一致。
     */
    private syncToCapabilityHub(): void {
        capabilityHub.clear()
        const entries: CapabilityEntry[] = [
            ...this.collectSkillEntries(),
            ...this.collectAgentEntries(),
            ...this.collectCommandEntries(),
        ]
        capabilityHub.registerBatch(entries)
        logger.debug('[PowerManager] syncToCapabilityHub', { total: entries.length })
    }

    /** 从 skillRegistry 收集技能条目 */
    private collectSkillEntries(): CapabilityEntry[] {
        const entries: CapabilityEntry[] = []
        const registry = PluginRegistry.getInstance()
        for (const s of skillRegistry.getAll()) {
            const pluginEnabled = s.pluginName
                ? (registry.get(s.pluginName)?.enabled ?? false)
                : undefined
            entries.push({
                id: s.id,
                name: s.name,
                description: s.description || s.userDescription || '',
                type: 'skill',
                source: s.source || 'builtin',
                pluginName: s.pluginName,
                pluginEnabled,
                enabled: s.enabled,
                content: s.content,
                allowedTools: s.allowedTools,
                searchText: '',
            })
        }
        return entries
    }

    /** 从 agentRegistry 收集 Agent 条目 */
    private collectAgentEntries(): CapabilityEntry[] {
        const entries: CapabilityEntry[] = []
        const registry = PluginRegistry.getInstance()
        for (const a of agentRegistry.getAll()) {
            if (a.id.startsWith('cmd:')) continue // 跳过内部命令条目
            const pluginTag = a.tags?.find(t => t.startsWith('plugin:'))
            const pluginName = pluginTag?.replace('plugin:', '')
            const pluginEnabled = pluginName
                ? (registry.get(pluginName)?.enabled ?? false)
                : undefined
            entries.push({
                id: a.id,
                name: a.name,
                description: a.description || a.userDescription || a.whenToUse || '',
                type: 'agent',
                source: pluginName ? 'plugin' : 'builtin',
                pluginName,
                pluginEnabled,
                enabled: a.enabled,
                content: a.systemPrompt,
                searchText: '',
            })
        }
        return entries
    }

    /** 从 CommandDispatcher 收集命令条目 */
    private collectCommandEntries(): CapabilityEntry[] {
        const entries: CapabilityEntry[] = []
        try {
            const dispatcher = CommandDispatcher.getInstance()
            const { pluginGroups, userCommands } = dispatcher.getAllCommands()
            const registry = PluginRegistry.getInstance()

            // 插件命令
            for (const [pluginName, cmds] of pluginGroups) {
                const plugin = registry.get(pluginName)
                for (const cmd of cmds) {
                    entries.push({
                        id: `cmd:${cmd.id}`,
                        name: cmd.name || cmd.id.split(':').pop() || cmd.id,
                        description: cmd.description || '',
                        type: 'command',
                        source: 'plugin',
                        pluginName,
                        pluginEnabled: plugin?.enabled ?? false,
                        enabled: true,
                        content: cmd.content,
                        hasArgs: (cmd.args?.length ?? 0) > 0 || /\$ARGUMENTS/gi.test(cmd.content || ''),
                        searchText: '',
                    })
                }
            }

            // 用户命令
            for (const cmd of userCommands) {
                entries.push({
                    id: `cmd:${cmd.id}`,
                    name: cmd.name,
                    description: cmd.description || '',
                    type: 'command',
                    source: 'user',
                    enabled: true,
                    content: cmd.content,
                    hasArgs: (cmd.args?.length ?? 0) > 0 || /\$ARGUMENTS/gi.test(cmd.content || ''),
                    searchText: '',
                })
            }
        } catch (err) {
            // CommandDispatcher 可能未初始化
            logger.debug('[PowerManager] syncToCapabilityHub: CommandDispatcher unavailable', {
                error: err instanceof Error ? err.message : String(err),
            })
        }
        return entries
    }

    /**
     * 获取所有插件名称
     */
    getPluginNames(): string[] {
        const registry = PluginRegistry.getInstance()
        return registry.getAll().map((p: any) => p.name)
    }

    /**
     * 获取待办列表
     */
    getTodoList(): Array<{ id: string; text: string; completed: boolean }> {
        // Placeholder - implement if needed
        return []
    }

    /**
     * 从能力 ID 提取插件名称
     * 支持 Agent、Skill、MCP 的 ID 格式
     */
    private extractPluginName(id: string): string | undefined {
        // Agent: plugin:{pluginName}:xxx
        if (id.startsWith('plugin:')) {
            const parts = id.split(':')
            if (parts.length >= 2) {
                return parts[1]
            }
        }

        // MCP: mcp_{pluginName}_{serverName}
        const mcpMatch = id.match(/^mcp_([^_]+)_.+/)
        if (mcpMatch) {
            return mcpMatch[1]
        }

        // Skill: 直接从 SkillDefinition.pluginName 字段读取，不需要解析 ID
        return undefined
    }
}

export const powerManager = new PowerManagerImpl()

// 兼容旧版本 API（拼写错误保留）
export const powerManagerV2 = powerManager
