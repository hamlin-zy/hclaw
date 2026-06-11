/**
 * Plugin Configuration Manager
 *
 * Manages persistent storage of plugin enabled/disabled states.
 * Uses SQLite plugins table to store configuration.
 */

import {createPluginRepository} from '../repositories'

export interface Plugin {
    name: string
    path: string
    enabled: boolean
}

export interface PluginsConfig {
    enabledPlugins: string[]
    disabledPlugins: string[]
}

const DEFAULT_CONFIG: PluginsConfig = {
    enabledPlugins: [],
    disabledPlugins: [],
}

/**
 * Load plugins configuration from SQLite
 * Returns default config if no plugins exist
 */
export function loadPluginsConfig(): PluginsConfig {
    try {
        const pluginRepo = createPluginRepository()
        const plugins = pluginRepo.list()

        if (plugins.length === 0) {
            return {...DEFAULT_CONFIG}
        }

        const enabledPlugins = plugins.filter(p => p.enabled).map(p => p.name)
        const disabledPlugins = plugins.filter(p => !p.enabled).map(p => p.name)

        return {enabledPlugins, disabledPlugins}
    } catch (err) {
        return {...DEFAULT_CONFIG}
    }
}

/**
 * Save plugins configuration to SQLite
 */
export function savePluginsConfig(config: PluginsConfig): boolean {
    try {
        const pluginRepo = createPluginRepository()
        const existingPlugins = pluginRepo.list()

        // Merge enabled/disabled lists into plugin enabled states
        const allPluginNames = new Set([...config.enabledPlugins, ...config.disabledPlugins])

        const plugins: Plugin[] = Array.from(allPluginNames).map(name => ({
            name,
            path: existingPlugins.find(p => p.name === name)?.path || '',
            enabled: config.enabledPlugins.includes(name),
        }))

        return pluginRepo.save(plugins)
    } catch (err) {
        return false
    }
}

/**
 * Check if a plugin is enabled based on config
 */
export function isPluginEnabled(pluginName: string, config: PluginsConfig): boolean {
    // Default behavior: if a plugin is in neither list, it's enabled
    // (This handles new plugins that haven't been toggled yet)
    if (config.enabledPlugins.includes(pluginName)) {
        return true;
    }
    if (config.disabledPlugins.includes(pluginName)) {
        return false;
    }
    // Plugin not in config - default to enabled
    return true;
}

/**
 * Enable a plugin in config
 */
export function enablePluginInConfig(pluginName: string, config: PluginsConfig): PluginsConfig {
    const newConfig = {...config};

    // Remove from disabled if present
    newConfig.disabledPlugins = newConfig.disabledPlugins.filter(name => name !== pluginName);

    // Add to enabled if not already there
    if (!newConfig.enabledPlugins.includes(pluginName)) {
        newConfig.enabledPlugins.push(pluginName);
    }

    return newConfig;
}

/**
 * Disable a plugin in config
 */
export function disablePluginInConfig(pluginName: string, config: PluginsConfig): PluginsConfig {
    const newConfig = {...config};

    // Remove from enabled if present
    newConfig.enabledPlugins = newConfig.enabledPlugins.filter(name => name !== pluginName);

    // Add to disabled if not already there
    if (!newConfig.disabledPlugins.includes(pluginName)) {
        newConfig.disabledPlugins.push(pluginName);
    }

    return newConfig;
}
