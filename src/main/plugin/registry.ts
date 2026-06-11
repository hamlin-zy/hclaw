import {CommandDef, HookConfig, LoadedPlugin} from './types';
import {eventBus, PluginEvents} from '../common/eventBus';

/**
 * PluginRegistry - Singleton registry for managing all loaded plugins
 *
 * Design Rationale:
 * - Singleton pattern ensures a single source of truth for plugin state
 * - Uses Map for O(1) lookups by plugin name
 * - Commands and hooks are extracted on registration for fast access
 * - Enables/disabled state is tracked separately from plugin data
 * - Plugin state changes are published via EventBus to notify capability managers
 */
export class PluginRegistry {
  private static instance: PluginRegistry;
  private plugins: Map<string, LoadedPlugin> = new Map();
  private commands: Map<string, CommandDef[]> = new Map();
  private hooks: Map<string, HookConfig[]> = new Map();

  private constructor() {}

  /**
   * Get the singleton instance of PluginRegistry
   */
  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  /**
   * Clear the registry - removes all plugins, commands, and hooks
   */
  clear(): void {
    this.plugins.clear();
    this.commands.clear();
    this.hooks.clear();
  }

  /**
   * Register a plugin and extract its commands and hooks
   * 发布插件安装事件
   */
  register(plugin: LoadedPlugin): void {
    this.plugins.set(plugin.name, plugin);

    // Extract commands from plugin
    if (plugin.commands && plugin.commands.length > 0) {
      this.commands.set(plugin.name, plugin.commands);
    }

    // Extract hooks from plugin
    if (plugin.hooks && plugin.hooks.length > 0) {
      this.hooks.set(plugin.name, plugin.hooks);
    }

      // 发布插件安装事件
      eventBus.emit(PluginEvents.INSTALLED, plugin.path);
  }

  /**
   * Unregister a plugin by name
   * 发布插件卸载事件
   */
  unregister(name: string): void {
    this.plugins.delete(name);
    this.commands.delete(name);
    this.hooks.delete(name);

      // 发布插件卸载事件
      eventBus.emit(PluginEvents.UNINSTALLED, name);
  }

  /**
   * Get a plugin by name
   */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all registered plugins
   */
  getAll(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get all enabled plugins
   */
  getEnabled(): LoadedPlugin[] {
    return this.getAll().filter((plugin) => plugin.enabled);
  }

  /**
   * Get the set of disabled plugin names (convenience for filtering)
   */
  getDisabledNames(): Set<string> {
    const names = new Set<string>()
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled) names.add(plugin.name)
    }
    return names
  }

  /**
   * Get plugins by source
   */
  getBySource(source: string): LoadedPlugin[] {
    return this.getAll().filter((plugin) => plugin.source === source);
  }

  /**
   * Get the path of a plugin by name
   */
  getPluginPath(name: string): string | undefined {
    return this.plugins.get(name)?.path;
  }

  /**
   * Update the enabled state of a plugin
   * 发布事件以通知能力管理器
   */
  updateEnabled(name: string, enabled: boolean): void {
    const plugin = this.plugins.get(name);
      if (plugin && plugin.enabled !== enabled) {
      plugin.enabled = enabled;

          // 发布插件启用/禁用事件
          if (enabled) {
              eventBus.emit(PluginEvents.ENABLED, name);
          } else {
              eventBus.emit(PluginEvents.DISABLED, name);
          }
    }
  }

  /**
   * Get all commands from all plugins
   * @returns Map<pluginName, CommandDef[]>
   */
  getCommands(): Map<string, CommandDef[]> {
    return new Map(this.commands);
  }

  /**
   * Get all hooks from all plugins
   * @returns Map<pluginName, HookConfig[]>
   */
  getHooks(): Map<string, HookConfig[]> {
    return new Map(this.hooks);
  }
}
