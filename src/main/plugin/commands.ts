import {ArgumentDef, CommandDef} from './types';
import {PluginRegistry} from './registry';
import {extractCommandName, getUserCommandStore} from '../command/userCommandStore';
import {loadCommands} from '../agent/commandLoader';
import type {CommandDefinition} from '@shared/types';

/**
 * CommandDispatcher - Singleton dispatcher for managing plugin and user commands
 *
 * Design Rationale:
 * - Plugin commands: loaded from PluginRegistry (plugins/), cached in commandCache
 * - User commands: loaded from ~/.hclaw/commands/*.md (file system), cached in userCommands
 * - Plugin command overrides: stored in user_commands table (source='plugin'), kept in DB
 * - User command enabled state overrides: stored in command_overrides table, applied by loadCommands()
 *
 * Priority: plugin override > plugin command > user command
 */
export class CommandDispatcher {
  private static instance: CommandDispatcher;
  private commandCache: Map<string, CommandDef> = new Map();
  private userCommands: Map<string, CommandDefinition> = new Map();

  private constructor() {}

  static getInstance(): CommandDispatcher {
    if (!CommandDispatcher.instance) {
      CommandDispatcher.instance = new CommandDispatcher();
    }
    return CommandDispatcher.instance;
  }

  /**
   * 刷新插件命令缓存（从 PluginRegistry 重新加载）
   */
  private refreshPluginCache(): void {
    this.commandCache.clear();
    const registry = PluginRegistry.getInstance();
    for (const [pluginName, commands] of registry.getCommands()) {
      const plugin = registry.get(pluginName);
      if (plugin?.enabled) {
        for (const command of commands) {
          this.commandCache.set(command.id, command);
        }
      }
    }
  }

  /**
   * Refresh all caches: plugin commands from PluginRegistry, user commands from file system
   */
  async refresh(): Promise<void> {
    this.refreshPluginCache();
    this.userCommands.clear();
    const fileCommands = await loadCommands();
    for (const cmd of fileCommands) {
      this.userCommands.set(`user:${cmd.name}`, cmd);
    }
  }

  /**
   * 同步刷新（不等待异步加载，仅刷新插件命令）
   * 用于不需要等待文件命令加载的场景（如 IPC handler 中的快速刷新）
   */
  refreshSync(): void {
    this.refreshPluginCache();
  }

  /**
   * Remove all commands from a specific plugin
   */
  unregisterByPlugin(pluginName: string): void {
    const prefix = `${pluginName}:`;
    for (const commandId of this.commandCache.keys()) {
      if (commandId.startsWith(prefix)) {
        this.commandCache.delete(commandId);
      }
    }
  }

  /**
   * Get all commands grouped by plugin name
   */
  getAll(): Map<string, CommandDef[]> {
    return PluginRegistry.getInstance().getCommands();
  }

  /**
   * Get a specific command by ID
   */
  getCommand(id: string): CommandDef | undefined {
    return this.commandCache.get(id);
  }

  /**
   * Check if a command has arguments
   */
  hasArgs(commandId: string): boolean {
    const cmd = this.commandCache.get(commandId);
    return !!cmd?.args?.length;
  }

  /**
   * Get argument definitions for a command
   */
  getArgs(commandId: string): ArgumentDef[] | undefined {
    return this.commandCache.get(commandId)?.args;
  }

  /**
   * Replace $ARGUMENTS placeholder in content (case-insensitive)
   */
  private static substituteArgs(content: string, args?: string): string {
    return args === undefined ? content : content.replace(/\$ARGUMENTS/gi, args);
  }

  /**
   * Prepare message content by replacing $ARGUMENTS with provided args.
   * Priority: plugin override > plugin command > user command
   */
  prepareMessage(commandId: string, args?: string): string {
    // 1) Check plugin override
    const override = getUserCommandStore().getPluginOverride(commandId);
    if (override) {
      if (!override.enabled) return '';
      if (override.content) {
        return CommandDispatcher.substituteArgs(override.content, args);
      }
    }

    // 2) Try plugin commands
    const pluginCmd = this.commandCache.get(commandId);
    if (pluginCmd) {
      return CommandDispatcher.substituteArgs(pluginCmd.content, args);
    }

    // 3) Try user commands (from file system)
    const userCmd = this.userCommands.get(commandId);
    if (userCmd?.enabled) {
      return CommandDispatcher.substituteArgs(userCmd.content, args);
    }

    return '';
  }

  /**
   * Get all commands merged from plugin system and file-based user commands,
   * including plugin command override info from user_commands.
   * Disabled plugin commands are filtered out from groups.
   */
  getAllCommands(): {
    pluginGroups: Map<string, CommandDef[]>;
    userCommands: CommandDefinition[];
    pluginCommandOverrides: Record<string, { enabled: boolean; edited?: boolean }>;
  } {
    const registry = PluginRegistry.getInstance();
    // Only include commands from enabled plugins
    const pluginGroups = new Map<string, CommandDef[]>();
    for (const [key, commands] of this.getAll()) {
      const plugin = registry.get(key);
      if (!plugin?.enabled) continue;
      pluginGroups.set(key, [...commands]);
    }

    // Get user commands from file system cache (only enabled ones for UI)
    const userCommands: CommandDefinition[] = []
    for (const cmd of this.userCommands.values()) {
      if (cmd.enabled) {
        userCommands.push(cmd)
      }
    }

    const overrides = getUserCommandStore().getPluginOverrides();

    // Build override map and collect disabled command IDs
    const pluginCommandOverrides: Record<string, { enabled: boolean; edited?: boolean }> = {};
    const disabledCommandIds = new Set<string>();

    for (const override of overrides) {
      if (!override.pluginCommandId) continue;
      pluginCommandOverrides[override.pluginCommandId] = {
        enabled: override.enabled,
        edited: override.content ? true : undefined,
      };
      if (!override.enabled) {
        disabledCommandIds.add(override.pluginCommandId);
      }
    }

    // Filter out disabled commands from groups
    for (const [pluginName, commands] of pluginGroups) {
      const filtered = commands.filter(cmd => !disabledCommandIds.has(cmd.id));
      if (filtered.length !== commands.length) {
        pluginGroups.set(pluginName, filtered);
      }
    }

    return {pluginGroups, userCommands, pluginCommandOverrides};
  }

  /**
   * Resolve a command by ID, checking plugin cache then user file commands
   */
  resolveCommand(id: string): { source: 'plugin' | 'user'; command: CommandDef | CommandDefinition } | null {
    return (
      this.resolvePlugin(id) ??
      this.resolveUserFile(id)
    );
  }

  private resolvePlugin(id: string): { source: 'plugin'; command: CommandDef } | null {
    const cmd = this.commandCache.get(id);
    return cmd ? {source: 'plugin' as const, command: cmd} : null;
  }

  private resolveUserFile(id: string): { source: 'user'; command: CommandDefinition } | null {
    const cmd = this.userCommands.get(id);
    return cmd?.enabled ? {source: 'user' as const, command: cmd} : null;
  }

  /**
   * Look up a command by name (without namespace prefix, case-insensitive)
   */
  lookupByName(name: string): { source: 'plugin' | 'user'; command: CommandDef | CommandDefinition; id: string } | null {
    const nameLower = name.toLowerCase();

    // Check user commands by name (from file system cache)
    for (const [cmdId, cmd] of this.userCommands) {
      if (cmd.name.toLowerCase() === nameLower && cmd.enabled) {
        return {source: 'user', command: cmd, id: cmdId};
      }
    }

    // Check plugin commands (case-insensitive)
    for (const [cmdId, cmd] of this.commandCache) {
      if (extractCommandName(cmdId).toLowerCase() !== nameLower) continue;

      // Check if plugin command is disabled via override
      const override = getUserCommandStore().getPluginOverride(cmdId);
      if (override && !override.enabled) return null;
      return {source: 'plugin', command: cmd, id: cmdId};
    }

    return null;
  }

  /**
   * Prepare message by command name (resolves the name internally)
   */
  prepareMessageByName(name: string, args?: string): { template: string; commandId: string } | null {
    const resolved = this.lookupByName(name);
    if (!resolved) return null;
    return {
      template: this.prepareMessage(resolved.id, args),
      commandId: resolved.id,
    };
  }
}
