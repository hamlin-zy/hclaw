/**
 * Plugin IPC Handlers
 *
 * Registers plugin-related IPC handlers in the main process.
 * These handlers bridge the renderer process and the plugin system.
 */

import * as fs from 'fs';
import {ipcMain, IpcMainInvokeEvent} from 'electron';
import * as path from 'path';
import {PluginRegistry} from './registry';
import {PluginInstaller} from './installer';
import {PluginLoader} from './loader';
import {CommandDispatcher} from './commands';
import {CommandDef, LoadedPlugin, PluginError, PluginSource} from './types';
import {powerManager} from '../agent/powerManager';
import {skillRegistry} from '../agent/skills';
import {buildSkillCommandTemplate} from '../agent/skills/guidance';
import {serializeSkills} from '../agent/skills/loader';
import {agentRegistry} from '../agent/agentRegistry';
import {resolveEntityCommand, buildAgentCommandTemplate} from '../agent/entityCommandResolver';
import {mcpService} from '../services/mcpService';
import {getHclawDir} from '../config';
import {
    disablePluginInConfig,
    enablePluginInConfig,
    isPluginEnabled,
    loadPluginsConfig,
    PluginsConfig,
    savePluginsConfig,
} from './plugins-config';
import {createPluginRepository} from '../repositories';
import {createLogger} from '../agent/logger';
import {getUserCommandStore, UpsertPluginOverrideInput, UserCommandData} from '../command/userCommandStore';
import {getPresetCommand, getPresetCommandMarkdownFiles, commandToMarkdown} from '../command/presetCommands';
import {loadCommands, getCommandsDir} from '../agent/commandLoader';
import type {CommandDefinition} from '@shared/types';
import {readHookConfig, writeHookConfig} from '../config/hookConfig';

const logger = createLogger('plugin')

/** 统一错误格式化 */
function asError(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

// Singleton instances
let registry: PluginRegistry;
let installer: PluginInstaller;
let loader: PluginLoader;
let initialized = false;
let pluginsConfig: PluginsConfig;

/**
 * Get the plugins directory path
 */
function getPluginsDir(): string {
    return path.join(getHclawDir(), 'plugins');
}

/**
 * Reset a plugin to its remote state — discards all local modifications
 */
async function handleReset(
  _event: IpcMainInvokeEvent,
  name: string
): Promise<Record<string, unknown>> {
  try {
    const plugin = registry.get(name);
    if (!plugin || !plugin.path) {
      return { success: false, error: { type: 'plugin-not-found', name } };
    }

    const result = await installer.reset(name, plugin.path);

    if (result.success) {
      const {skills, agents} = await refreshPowerManagerAndGetCapabilities();
      logger.info('[PluginReset] success', {name, skills: skills.length, agents: agents.length});
      return { ...result, skills, agents };
    }

    logger.error('[PluginReset] failed', {name, error: result.error});
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    logger.error('[PluginReset] exception', {name, error: asError(err)});
    return { success: false, error: { type: 'git-clone-failed', message: asError(err) } };
  }
}

/**
 * Initialize the plugin system components
 * Called once during main process startup
 */
export function initializePluginSystem(): void {
  if (initialized) {
    return;
  }

  // Load plugins configuration (enabled/disabled states)
  pluginsConfig = loadPluginsConfig();

  const pluginsDir = getPluginsDir();

  // Ensure plugins directory exists
  const fs = require('fs');
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  // Initialize components
  registry = PluginRegistry.getInstance();
  installer = new PluginInstaller(pluginsDir);
  loader = new PluginLoader(registry);

  initialized = true;
}

/**
 * Load installed plugins at startup
 * Called after initializePluginSystem()
 */
export async function initializePlugins(): Promise<void> {
  if (!initialized) {
    initializePluginSystem();
  }
  const pluginsDir = getPluginsDir();
  await loader.loadAllPlugins(pluginsDir);

  // 清理数据库中的无效记录（路径为空的旧名字残留）
  try {
    const pluginRepo = createPluginRepository();
    pluginRepo.cleanup();
  } catch { /* ignore */ }

  // Apply persisted enabled/disabled states from config
  for (const plugin of registry.getAll()) {
    const shouldBeEnabled = isPluginEnabled(plugin.name, pluginsConfig);
    if (plugin.enabled !== shouldBeEnabled) {
      registry.updateEnabled(plugin.name, shouldBeEnabled);
    }
  }
}

/**
 * Register all plugin IPC handlers
 * Called from main process initialization
 */
export function registerPluginIPC(): void {
  // Ensure plugin system is initialized
  initializePluginSystem();

  // Register handlers
  ipcMain.handle('plugin:install', handleInstall);
  ipcMain.handle('plugin:uninstall', handleUninstall);
  ipcMain.handle('plugin:enable', handleEnable);
  ipcMain.handle('plugin:disable', handleDisable);
  ipcMain.handle('plugin:list', handleList);
  ipcMain.handle('plugin:get-real-counts', handleGetRealCounts);
  ipcMain.handle('plugin:get-capability-details', handleGetCapabilityDetails);
  ipcMain.handle('plugin:get-commands', handleGetCommands);
  ipcMain.handle('plugin:reload', handleReload);
  ipcMain.handle('plugin:update', handleUpdate);
  ipcMain.handle('plugin:reset', handleReset);
  ipcMain.handle('command:prepare-message', handlePrepareMessage);

  // ── 用户命令管理 IPC handlers ──
  ipcMain.handle('command:resolve-by-name', handleResolveByName);
  ipcMain.handle('command:get-all', handleGetAllCommands);
  ipcMain.handle('command:get-user-commands', handleGetUserCommands);
  ipcMain.handle('command:create', handleCreateCommand);
  ipcMain.handle('command:update', handleUpdateCommand);
  ipcMain.handle('command:delete', handleDeleteCommand);
  ipcMain.handle('command:toggle', handleToggleCommand);
  ipcMain.handle('command:import', handleImportCommands);
  ipcMain.handle('command:export', handleExportCommands);
    ipcMain.handle('command:get-default-template', handleGetDefaultTemplate);
    ipcMain.handle('command:reset-presets', handleResetPresets);

    // ── 命令覆盖管理 IPC handlers ──
    ipcMain.handle('command-override:get-all', handleGetCommandOverrides);

    // ── 技能命令 IPC handlers ──
    ipcMain.handle('command:get-skill-commands', handleGetSkillCommands);

    // ── Agent 命令 IPC handlers ──
    ipcMain.handle('command:get-agent-commands', handleGetAgentCommands);

    // ── 插件命令覆盖管理 IPC handlers ──
    ipcMain.handle('plugin-command:get-overrides', handleGetPluginCommandOverrides);
    ipcMain.handle('plugin-command:upsert-override', handleUpsertPluginCommandOverride);
    ipcMain.handle('plugin-command:delete-override', handleDeletePluginCommandOverride);
}

/**
 * Install a plugin from a source URL
 */
async function handleInstall(
  _event: IpcMainInvokeEvent,
  sourceUrl: string
): Promise<{ success: boolean; plugin?: LoadedPlugin; error?: PluginError }> {
  try {
    // Parse the source URL
    const source = parseSourceUrl(sourceUrl);
    if (!source) {
      return {
        success: false,
        error: { type: 'git-clone-failed', message: `Invalid source URL: ${sourceUrl}` },
      };
    }

    // Install the plugin
    const result = await installer.install(source);
    if (!result.success || !result.path) {
      return { success: false, error: result.error };
    }

    // Load and register the plugin
    const loadedPlugin = await loader.loadPlugin(result.path);
    logger.info('install', {pluginName: loadedPlugin.name, path: result.path})
    registry.register(loadedPlugin);

    // CRITICAL: Explicitly set enabled state to ensure in-memory state is correct
    // This is necessary because loadSkillsFromPlugins() looks up plugins by directory name,
    // and if the directory name doesn't match manifest.name, the lookup would fail
    registry.updateEnabled(loadedPlugin.name, true);
    logger.debug('install', {pluginName: loadedPlugin.name, registryState: registry.getAll().map(p => `${p.name}=${p.enabled}`)})

    // Save plugin to config (new plugins are enabled by default)
    pluginsConfig.enabledPlugins.push(loadedPlugin.name);
    pluginsConfig.disabledPlugins = pluginsConfig.disabledPlugins.filter(p => p !== loadedPlugin.name);

    // Save plugin with path to SQLite BEFORE savePluginsConfig overwrites it with empty path
    const pluginRepo = createPluginRepository();
    const existingPluginsBeforeSave = pluginRepo.list();
    const allPluginNames = Array.from(new Set([...pluginsConfig.enabledPlugins, ...pluginsConfig.disabledPlugins]));
    const pluginsWithPath = allPluginNames.map(name => ({
        name,
        path: name === loadedPlugin.name ? result.path! : (existingPluginsBeforeSave.find(p => p.name === name)?.path || ''),
        enabled: pluginsConfig.enabledPlugins.includes(name),
    }));
    pluginRepo.save(pluginsWithPath);

    // Now update the in-memory config
    savePluginsConfig(pluginsConfig);

    // 刷新 PowerManager 以加载新插件的 capabilities（agents、skills、mcp）
    await powerManager.refresh();

    return { success: true, plugin: loadedPlugin };
  } catch (err) {
      const message = asError(err);
    return {
      success: false,
      error: { type: 'git-clone-failed', message },
    };
  }
}

/**
 * Uninstall a plugin by name
 */
async function handleUninstall(
  _event: IpcMainInvokeEvent,
  name: string
): Promise<{ success: boolean; error?: PluginError }> {
  try {
    // Unregister first
    registry.unregister(name);

    // Uninstall from filesystem
    const result = await installer.uninstall(name);

    // Clean up config - remove from enabled/disabled lists
    if (result.success) {
      pluginsConfig.enabledPlugins = pluginsConfig.enabledPlugins.filter(p => p !== name);
      pluginsConfig.disabledPlugins = pluginsConfig.disabledPlugins.filter(p => p !== name);
      savePluginsConfig(pluginsConfig);

      await refreshPowerManagerAndGetCapabilities();
    }

    return { success: result.success, error: result.error };
  } catch (err) {
      const message = asError(err);
    return {
      success: false,
      error: { type: 'git-clone-failed', message },
    };
  }
}

/**
 * 刷新 PowerManager 并返回更新后的 skills 和 agents
 */
async function refreshPowerManagerAndGetCapabilities(): Promise<{ skills: unknown[]; agents: unknown[] }> {
  powerManager.resetInitialized()
  await powerManager.refresh()
  const allSkills = skillRegistry.getAll()
  const allAgents = agentRegistry.getAll()
  return { skills: serializeSkills(allSkills), agents: allAgents }
}

/**
 * Enable a plugin by name
 */
async function handleEnable(
  _event: IpcMainInvokeEvent,
  name: string
): Promise<{ success: boolean; error?: string; skills?: unknown[]; agents?: unknown[] }> {
  const plugin = registry.get(name);
  if (!plugin) {
    return { success: false, error: `Plugin not found: ${name}` };
  }

  registry.updateEnabled(name, true);

  // 持久化配置
  pluginsConfig = enablePluginInConfig(name, pluginsConfig);
  savePluginsConfig(pluginsConfig);

  // 注：不需要手动调用 capabilityHub.onPluginStateChange，
  // refreshPowerManagerAndGetCapabilities → powerManager.refresh → syncToCapabilityHub
  // 会 clear + 重建整个 Hub，状态自然正确

  const {skills, agents} = await refreshPowerManagerAndGetCapabilities();
  return { success: true, skills, agents };
}

/**
 * Disable a plugin by name
 */
async function handleDisable(
  _event: IpcMainInvokeEvent,
  name: string
): Promise<{ success: boolean; error?: string; skills?: unknown[]; agents?: unknown[] }> {
  const plugin = registry.get(name);
  if (!plugin) {
    return { success: false, error: `Plugin not found: ${name}` };
  }

  registry.updateEnabled(name, false);

  // 持久化配置
  pluginsConfig = disablePluginInConfig(name, pluginsConfig);
  savePluginsConfig(pluginsConfig);

  // 注：不需要手动调用 capabilityHub.onPluginStateChange，同上

  const {skills, agents} = await refreshPowerManagerAndGetCapabilities();
  return { success: true, skills, agents };
}

/**
 * List all plugins
 */
async function handleList(
  _event: IpcMainInvokeEvent,
  enabledOnly?: boolean
): Promise<LoadedPlugin[]> {
  if (enabledOnly) {
    return registry.getEnabled();
  }
  return registry.getAll();
}

/**
 * Get real capability counts from authoritative registries (not PluginLoader's simplified scan).
 *
 * PluginLoader's parseSkills/parseAgents use different scanning rules than the actual
 * skillRegistry/agentRegistry/mcpService, causing count discrepancies. This handler
 * returns the REAL counts so the UI displays accurate numbers after a single scan.
 *
 * Returns: Record<pluginName, { skills: number; agents: number; mcps: number }>
 */
async function handleGetRealCounts(
    _event: IpcMainInvokeEvent
): Promise<Record<string, { skills: number; agents: number; mcps: number; hooks: number }>> {
    const result: Record<string, { skills: number; agents: number; mcps: number; hooks: number }> = {}

    const registry = PluginRegistry.getInstance()
    const allPlugins = registry.getAll()

    // 从 skillRegistry 按 pluginName 聚合
    const allSkills = skillRegistry.getAll()

    // 从 agentRegistry 按 id 前缀聚合
    const allAgents = agentRegistry.getAll()

    // 从 mcpService 按 id 前缀聚合
    const allMcps = mcpService.list()

    // 从 PluginRegistry 获取所有插件的 hooks（keyed by pluginName）
    const allPluginHooks = registry.getHooks()

    for (const plugin of allPlugins) {
        const pluginName = plugin.name

        // Skills: 直接匹配 pluginName 字段
        const skills = allSkills.filter(s => s.pluginName === pluginName).length

        // Agents: id 以 pluginName 开头（格式: pluginName:agentName）
        const agents = allAgents.filter(a => a.id.startsWith(`${pluginName}:`)).length

        // MCPs: id 以 plugin:pluginName: 开头（由 tagPluginServer 生成）
        const mcps = allMcps.filter(m => (m.id as string)?.startsWith(`plugin:${pluginName}:`)).length

        // Hooks: 从 PluginRegistry 按 pluginName 直接获取
        const hooks = allPluginHooks.get(pluginName)?.length ?? 0

        result[pluginName] = { skills, agents, mcps, hooks }
    }

    return result
}

/**
 * Get full capability details for a plugin from the authoritative registries.
 * Used by the expanded detail view in PluginDialog.
 *
 * Returns: { skills: SkillDefinition[], agents: AgentTemplate[], mcps: McpServerConfig[] }
 */
async function handleGetCapabilityDetails(
    _event: IpcMainInvokeEvent,
    pluginName: string
): Promise<{
    skills: Record<string, unknown>[];
    agents: Record<string, unknown>[];
    mcps: Record<string, unknown>[];
}> {
    const skills = skillRegistry.getAll()
        .filter(s => s.pluginName === pluginName)
        .map(s => ({
            name: s.name,
            description: s.description,
            userInvocable: true,
            allowedTools: s.allowedTools,
        }))

    const agents = agentRegistry.getAll()
        .filter(a => a.id.startsWith(`${pluginName}:`))
        .map(a => ({
            name: a.name,
            description: a.description,
            type: a.model,
        }))

    const mcps = mcpService.list()
        .filter(m => (m.id as string)?.startsWith(`plugin:${pluginName}:`))
        .map(m => ({
            command: m.command,
            args: m.args,
            env: m.env,
            transport: m.transport,
        }))

    return { skills, agents, mcps }
}

/**
 * Get all commands from enabled plugins only
 */
async function handleGetCommands(
  _event: IpcMainInvokeEvent
): Promise<Record<string, CommandDef[]>> {
  const commands = registry.getCommands();
  const result: Record<string, CommandDef[]> = {};

  commands.forEach((cmds, pluginName) => {
    const plugin = registry.get(pluginName);
    // Only include commands from enabled plugins
    if (plugin?.enabled) {
      result[pluginName] = cmds;
    }
  });

  return result;
}

/**
 * Reload all plugins
 */
async function handleReload(_event: IpcMainInvokeEvent): Promise<{ success: boolean; plugins?: LoadedPlugin[]; error?: string }> {
  try {
    const pluginsDir = getPluginsDir();
    registry.clear();
    const plugins = await loader.loadAllPlugins(pluginsDir);

    // Re-apply persisted enabled/disabled states from config
    for (const plugin of registry.getAll()) {
      const shouldBeEnabled = isPluginEnabled(plugin.name, pluginsConfig);
      if (plugin.enabled !== shouldBeEnabled) {
        registry.updateEnabled(plugin.name, shouldBeEnabled);
      }
    }

    return { success: true, plugins };
  } catch (err) {
      const message = asError(err);
    return { success: false, error: message };
  }
}

/**
 * Update a plugin by name
 * Delegates to PluginInstaller.update() with normal/force modes.
 * Returns updated result with skills and agents for UI sync.
 */
async function handleUpdate(
  _event: IpcMainInvokeEvent,
  name: string,
  options?: { force?: boolean }
): Promise<Record<string, unknown>> {
  try {
    const result = await installer.update(name, options ?? {});

    if (result.success && result.path) {
      // Save hook enabled states before unregister (which triggers deletePluginHooks)
      const oldHooks = readHookConfig().filter(h => h.pluginName === name);
      const oldEnabledMap = new Map(oldHooks.map(h => [h.id, h.enabled]));

      // Re-register the plugin from disk (unregister first to avoid duplicates)
      registry.unregister(name);
      const loadedPlugin = await loader.loadPlugin(result.path);

      // Re-apply enabled/disabled state from persisted config
      const shouldBeEnabled = isPluginEnabled(name, pluginsConfig);
      registry.updateEnabled(name, shouldBeEnabled);

      // Restore hook enabled states that were reset by unregister→deletePluginHooks→syncPluginHooks
      const allHooks = readHookConfig();
      let restoredCount = 0;
      for (const hook of allHooks) {
        if (oldEnabledMap.has(hook.id)) {
          hook.enabled = oldEnabledMap.get(hook.id)!;
          restoredCount++;
        }
      }
      if (restoredCount > 0) {
        writeHookConfig(allHooks);
      }

      // Refresh powerManager to reload capabilities (skills/agents/mcp)
      powerManager.resetInitialized();
      await powerManager.refresh();

      // Return updated skills and agents for UI sync
      const allSkills = skillRegistry.getAll();
      const allAgents = agentRegistry.getAll();
      return { ...result, skills: serializeSkills(allSkills), agents: allAgents };
    }

    return result as unknown as Record<string, unknown>;
  } catch (err) {
    return {
      success: false,
      error: { type: 'git-clone-failed', message: asError(err) }
    };
  }
}

/**
 * Map registry entities to command list items for the renderer
 */
function mapRegistryToCommands<T extends { id: string; name: string }>(
    prefix: string,
    entities: T[],
    getDescription: (e: T) => string,
): Array<{ id: string; name: string; description: string }> {
    return entities.map(e => ({
        id: `${prefix}:${e.id}`,
        name: e.name,
        description: getDescription(e),
    }));
}

/**
 * Get all enabled agent commands (for rendering in CommandPalette/CommandList)
 */
async function handleGetAgentCommands(
    _event: IpcMainInvokeEvent
): Promise<Array<{ id: string; name: string; description: string }>> {
    // 过滤掉禁用插件的 Agent（通过 tags 中 plugin:xxx 提取插件名，与 syncPluginStatus 保持一致）
    const disabledPlugins = PluginRegistry.getInstance().getDisabledNames()
    const eligibleAgents = agentRegistry.getEnabled().filter(a => {
        const pluginTag = a.tags?.find(t => t.startsWith('plugin:'))
        if (pluginTag) {
            const pluginName = pluginTag.replace('plugin:', '')
            if (disabledPlugins.has(pluginName)) return false
        }
        return true
    })
    return mapRegistryToCommands('agent', eligibleAgents,
        a => a.description || a.userDescription || a.whenToUse || '');
}

/**
 * Resolve skill:/agent: prefixed command IDs by routing to the appropriate template builder
 */
function resolvePrefixedCommand(commandId: string): string {
    if (commandId.startsWith('skill:')) {
        const skill = skillRegistry.find(commandId.slice(6))
        return skill?.enabled ? buildSkillCommandTemplate(skill) : ''
    }
    if (commandId.startsWith('agent:')) {
        const agent = agentRegistry.get(commandId.slice(6)) || agentRegistry.find(commandId.slice(6))
        return agent?.enabled ? buildAgentCommandTemplate(agent) : ''
    }
    return ''
}

/**
 * Prepare message content from a command by replacing $ARGUMENTS placeholder
 * Supports plugin commands, user commands, skill commands (skill: prefix), and agent commands (agent: prefix)
 */
async function handlePrepareMessage(
  _event: IpcMainInvokeEvent,
  commandId: string,
  args?: string
): Promise<string> {
    const prefixResult = resolvePrefixedCommand(commandId)
    if (prefixResult !== '') return prefixResult

  const dispatcher = CommandDispatcher.getInstance();
  await dispatcher.refresh();

  return dispatcher.prepareMessage(commandId, args);
}

/**
 * Resolve a command by name (no namespace prefix needed)
 * Used by / prefix command detection in InputArea
 * Falls back to skill/agent registries if no command is found
 */
async function handleResolveByName(
  _event: IpcMainInvokeEvent,
  name: string,
  args?: string
): Promise<{template: string; commandId: string} | null> {
    // 1. 先查命令系统
  const dispatcher = CommandDispatcher.getInstance();
  await dispatcher.refresh();
    const commandResult = dispatcher.prepareMessageByName(name, args);
    if (commandResult) return commandResult;

    // 2. 兜底查技能/Agent（复用 entityCommandResolver，与 setup.ts 一致）
    return resolveEntityCommand(name);
}

/**
 * Get all enabled skill commands (for rendering in CommandPalette/CommandList)
 */
async function handleGetSkillCommands(
    _event: IpcMainInvokeEvent
): Promise<Array<{ id: string; name: string; description: string }>> {
    // 过滤掉禁用插件的技能：不能直接信赖 skill.enabled（applySkillOverrides 可能覆盖），
    // 必须从 PluginRegistry 获取插件的真实启用状态
    const disabledPlugins = PluginRegistry.getInstance().getDisabledNames()
    const eligibleSkills = skillRegistry.getEnabled().filter(s => {
        if (s.pluginName && disabledPlugins.has(s.pluginName)) return false
        return true
    })
    return mapRegistryToCommands('skill', eligibleSkills,
        s => s.description || s.userDescription || '');
}

/**
 * Get all commands (plugin groups + user commands)
 */
async function handleGetAllCommands(
  _event: IpcMainInvokeEvent
): Promise<{
  pluginGroups: Record<string, CommandDef[]>;
    userCommands: CommandDefinition[];
    pluginCommandOverrides: Record<string, { enabled: boolean; edited?: boolean }>;
}> {
  const dispatcher = CommandDispatcher.getInstance();
  await dispatcher.refresh();

    const {pluginGroups, userCommands, pluginCommandOverrides} = dispatcher.getAllCommands();

  // Convert Map to Record for IPC serialization
  const pluginGroupsRecord: Record<string, CommandDef[]> = {};
  pluginGroups.forEach((cmds, pluginName) => {
    pluginGroupsRecord[pluginName] = cmds;
  });

    return {pluginGroups: pluginGroupsRecord, userCommands, pluginCommandOverrides};
}

/**
 * Get only user-defined commands (from file system)
 */
async function handleGetUserCommands(
  _event: IpcMainInvokeEvent
): Promise<{success: boolean; data?: CommandDefinition[]; error?: string}> {
  try {
    const commands = await loadCommands()
    return {success: true, data: commands}
  } catch (err) {
    return {success: false, error: asError(err)}
  }
}

/**
 * Create a user-defined command (write to file system)
 */
async function handleCreateCommand(
  _event: IpcMainInvokeEvent,
  input: { name: string; description?: string; content: string; args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>; enabled?: boolean }
): Promise<{success: boolean; error?: string}> {
  try {
    const markdown = commandToMarkdown({
      name: input.name,
      description: input.description || '',
      enabled: input.enabled !== false,
      args: input.args,
      content: input.content,
    })
    const filePath = path.join(getCommandsDir(), `${input.name}.md`)
    // 安全检查：确保路径在命令目录内
    if (!filePath.startsWith(getCommandsDir())) {
      return {success: false, error: 'Invalid command name'}
    }
    fs.writeFileSync(filePath, markdown, 'utf-8')
    return {success: true}
  } catch (err) {
    return {success: false, error: asError(err)}
  }
}

/**
 * Update a user-defined command (rewrite file)
 */
async function handleUpdateCommand(
  _event: IpcMainInvokeEvent,
  id: string,
  updates: { name?: string; description?: string; content?: string; args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>; enabled?: boolean }
): Promise<{success: boolean; error?: string}> {
  try {
    const commandName = id.startsWith('user:') ? id.slice(5) : id
    const cmdsDir = getCommandsDir()
    const filePath = path.join(cmdsDir, `${commandName}.md`)

    if (!filePath.startsWith(cmdsDir) || !fs.existsSync(filePath)) {
      return {success: false, error: 'Command not found'}
    }

    // Read existing content and merge updates
    const existingContent = fs.readFileSync(filePath, 'utf-8')
    const match = existingContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) return {success: false, error: 'Invalid command file format'}

    const frontmatter = JSON.parse(JSON.stringify(require('js-yaml').load(match[1]))) || {}
    const bodyContent = updates.content !== undefined ? updates.content : match[2].trim()

    // Merge frontmatter updates
    if (updates.name !== undefined) frontmatter.name = updates.name
    if (updates.description !== undefined) frontmatter.description = updates.description
    if (updates.enabled !== undefined) frontmatter.enabled = updates.enabled
    if (updates.args !== undefined) frontmatter.args = updates.args

    // Write back
    const yaml = require('js-yaml')
    const newContent = `---\n${yaml.dump(frontmatter).trimEnd()}\n---\n\n${bodyContent}`

    // If name changed, remove old file
    if (updates.name && updates.name !== commandName) {
      fs.unlinkSync(filePath)
      const newPath = path.join(cmdsDir, `${updates.name}.md`)
      if (!newPath.startsWith(cmdsDir)) return {success: false, error: 'Invalid name'}
      fs.writeFileSync(newPath, newContent, 'utf-8')
    } else {
      fs.writeFileSync(filePath, newContent, 'utf-8')
    }

    return {success: true}
  } catch (err) {
    return {success: false, error: asError(err)}
  }
}

/**
 * Delete a user-defined command (remove file + clean up overrides)
 */
async function handleDeleteCommand(
  _event: IpcMainInvokeEvent,
  id: string
): Promise<{success: boolean; error?: string}> {
  try {
    const commandName = id.startsWith('user:') ? id.slice(5) : id
    const cmdsDir = getCommandsDir()
    const filePath = path.join(cmdsDir, `${commandName}.md`)

    if (!filePath.startsWith(cmdsDir)) {
      return {success: false, error: 'Invalid command id'}
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    // Also clean up any override record
    try {
      const db = require('../repositories/sqlite').getDatabase()
      const {saveDatabase} = require('../repositories/sqlite')
      db.prepare('DELETE FROM command_overrides WHERE command_id = ?').run(commandName)
      saveDatabase()
    } catch { /* ignore db cleanup errors */ }

    return {success: true}
  } catch (err) {
    return {success: false, error: asError(err)}
  }
}

/**
 * Toggle enable/disable a user-defined command (write to command_overrides)
 */
async function handleToggleCommand(
  _event: IpcMainInvokeEvent,
  id: string,
  enabled: boolean
): Promise<{success: boolean; error?: string}> {
  try {
    const commandName = id.startsWith('user:') ? id.slice(5) : id
    const {getDatabase, saveDatabase} = await import('../repositories/sqlite')
    const db = getDatabase()

    // Check if command file exists
    const filePath = path.join(getCommandsDir(), `${commandName}.md`)
    if (!filePath.startsWith(getCommandsDir()) || !fs.existsSync(filePath)) {
      return {success: false, error: 'Command not found'}
    }

    db.prepare(
      'INSERT OR REPLACE INTO command_overrides (command_id, enabled, updated_at) VALUES (?, ?, ?)'
    ).run(commandName, enabled ? 1 : 0, Date.now())
    saveDatabase()

    // 刷新 CapabilityHub，使管理界面能立即反映状态变化
    await powerManager.refresh()

    return {success: true}
  } catch (err) {
    return {success: false, error: asError(err)}
  }
}

/**
 * Import user commands from JSON array (write to file system)
 */
async function handleImportCommands(
  _event: IpcMainInvokeEvent,
  commands: Array<{
    name: string
    description?: string
    content: string
    args?: Array<{name: string; description?: string; required?: boolean; default?: string}>
    enabled?: boolean
  }>
): Promise<{success: boolean; imported: number; skipped: number; error?: string}> {
  try {
    const cmdsDir = getCommandsDir()
    let imported = 0
    let skipped = 0

    for (const cmd of commands) {
      const filePath = path.join(cmdsDir, `${cmd.name}.md`)
      if (!filePath.startsWith(cmdsDir)) {
        skipped++
        continue
      }
      if (fs.existsSync(filePath)) {
        skipped++
        continue
      }
      const markdown = commandToMarkdown({...cmd, description: cmd.description || ''})
      fs.writeFileSync(filePath, markdown, 'utf-8')
      imported++
    }

    return {success: true, imported, skipped}
  } catch (err) {
    return {success: false, imported: 0, skipped: 0, error: asError(err)}
  }
}

/**
 * Export user commands as JSON array (read from file system)
 */
async function handleExportCommands(
  _event: IpcMainInvokeEvent
): Promise<{success: boolean; commands?: unknown[]; error?: string}> {
  try {
    const commands = await loadCommands()
    const exportData = commands.map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      content: cmd.content,
      args: cmd.args,
      enabled: cmd.enabled,
    }))
    return {success: true, commands: exportData}
  } catch (err) {
    return {success: false, error: asError(err)}
  }
}

/**
 * Get default template for a built-in command
 */
async function handleGetDefaultTemplate(
    _event: IpcMainInvokeEvent,
    name: string
): Promise<{
    content: string;
    description?: string;
    args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>;
} | null> {
    const preset = getPresetCommand(name);
    if (!preset) return null;
    return {
        content: preset.content,
        description: preset.description,
        args: preset.args,
    };
}

/**
 * Reset preset command files (re-generate from source)
 */
async function handleResetPresets(
    _event: IpcMainInvokeEvent
): Promise<{success: boolean; error?: string}> {
    try {
        const cmdsDir = getCommandsDir()
        const presetFiles = getPresetCommandMarkdownFiles()
        for (const {filename, content} of presetFiles) {
            const filePath = path.join(cmdsDir, filename)
            if (!filePath.startsWith(cmdsDir)) {
                return {success: false, error: `Invalid path: ${filename}`}
            }
            // 确保目录存在
            if (!fs.existsSync(cmdsDir)) {
                fs.mkdirSync(cmdsDir, {recursive: true})
            }
            fs.writeFileSync(filePath, content, 'utf-8')
        }
        return {success: true}
    } catch (err) {
        return {success: false, error: asError(err)}
    }
}

/**
 * Get all command overrides from command_overrides table
 */
async function handleGetCommandOverrides(
    _event: IpcMainInvokeEvent
): Promise<Array<{ command_id: string; enabled: boolean; updated_at: number }>> {
    try {
        const {getDatabase} = await import('../repositories/sqlite')
        const db = getDatabase()
        const rows = db.prepare('SELECT command_id, enabled, updated_at FROM command_overrides').all() as Array<{
            command_id: string
            enabled: number
            updated_at: number
        }>
        return rows.map(r => ({command_id: r.command_id, enabled: r.enabled === 1, updated_at: r.updated_at}))
    } catch {
        return []
    }
}

/**
 * Get all plugin command overrides
 */
async function handleGetPluginCommandOverrides(
    _event: IpcMainInvokeEvent
): Promise<UserCommandData[]> {
    return getUserCommandStore().getPluginOverrides();
}

/**
 * Upsert (create or update) a plugin command override
 */
async function handleUpsertPluginCommandOverride(
    _event: IpcMainInvokeEvent,
    input: UpsertPluginOverrideInput
): Promise<{ success: boolean; error?: string }> {
    try {
        getUserCommandStore().upsertPluginOverride(input);
        return {success: true};
    } catch (err) {
        return {success: false, error: asError(err)};
    }
}

/**
 * Delete a plugin command override (restore original)
 */
async function handleDeletePluginCommandOverride(
    _event: IpcMainInvokeEvent,
    pluginCommandId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const result = getUserCommandStore().deletePluginOverride(pluginCommandId);
        return {success: result};
    } catch (err) {
        return {success: false, error: asError(err)};
    }
}

/**
 * Parse a source URL into a PluginSource
 */
function parseSourceUrl(url: string): PluginSource | null {
  // Handle GitHub URLs
  // https://github.com/owner/repo[/tree/branch]
  const githubMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?$/);
  if (githubMatch) {
    const [, owner, repo, ref] = githubMatch;
    return {
      source: 'github',
      repo: `${owner}/${repo.replace(/\.git$/, '')}`,
      ref,
    };
  }

  // Handle Gitee URLs
  // https://gitee.com/owner/repo[/tree/branch]
  const giteeMatch = url.match(/^https:\/\/gitee\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?$/);
  if (giteeMatch) {
    const [, owner, repo, ref] = giteeMatch;
    return {
      source: 'gitee',
      repo: `${owner}/${repo.replace(/\.git$/, '')}`,
      ref,
    };
  }

  // Handle GitLab URLs
  // https://gitlab.com/owner/repo[/-/tree/branch]
  const gitlabMatch = url.match(/^https:\/\/gitlab\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/-\/tree\/([^/]+))?$/);
  if (gitlabMatch) {
    const [, owner, repo, ref] = gitlabMatch;
    return {
      source: 'gitlab',
      repo: `${owner}/${repo.replace(/\.git$/, '')}`,
      ref,
    };
  }

  // Handle SSH URLs — git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return {
      source: 'github',
      repo: `${owner}/${repo.replace(/\.git$/, '')}`,
    };
  }

  // Handle owner/repo format (defaults to GitHub)
  const directMatch = url.match(/^([^/]+)\/([^/]+)$/);
  if (directMatch) {
    return {
      source: 'github',
      repo: url,
    };
  }

  // Handle local paths
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || /^[a-zA-Z]:/.test(url)) {
    return {
      source: 'local',
      path: url,
    };
  }

  return null;
}
