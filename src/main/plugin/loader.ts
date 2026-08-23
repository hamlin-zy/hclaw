import * as fsPromises from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import jsYaml from 'js-yaml';
import {PluginRegistry} from './registry';
import {
    AgentDefinition,
    ArgumentDef,
    CommandDef,
    LoadedPlugin,
    McpServerConfig,
    PluginManifest,
    SkillDefinition,
} from './types';

/**
 * PluginLoader - Loads and parses plugin directories
 *
 * Design Rationale:
 * - Lazy loading: Commands are only parsed when needed
 * - Validates plugin structure before attempting to parse
 * - Uses gray-matter for YAML frontmatter parsing in .md files
 * - Command IDs use plugin:command format for namespace isolation
 */
export class PluginLoader {
  private registry: PluginRegistry;

  constructor(registry?: PluginRegistry) {
    this.registry = registry || PluginRegistry.getInstance();
  }

  /**
   * Load a single plugin from a plugin path
   * @param pluginPath - Absolute path to the plugin directory
   * @returns LoadedPlugin with commands and mcpServers parsed
   */
  async loadPlugin(pluginPath: string): Promise<LoadedPlugin> {
      // Support both .claude-plugin/plugin.json (HClaw convention) and root plugin.json (open source convention)
      const claudePluginManifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');
      const rootManifestPath = path.join(pluginPath, 'plugin.json');

      let manifestPath: string;
      try {
        await fsPromises.access(claudePluginManifestPath)
        manifestPath = claudePluginManifestPath;
      } catch {
        try {
          await fsPromises.access(rootManifestPath)
          manifestPath = rootManifestPath;
        } catch {
          throw new Error(`Plugin manifest not found. Expected at ${claudePluginManifestPath} or ${rootManifestPath}`);
        }
      }

    const manifestContent = await fsPromises.readFile(manifestPath, 'utf-8');
    let manifest: PluginManifest;

    try {
      manifest = JSON.parse(manifestContent);
    } catch {
      throw new Error(`Invalid JSON in plugin manifest: ${manifestPath}`);
    }

    const pluginName = manifest.name || path.basename(pluginPath);

    // Parse commands from .md files
    const commands = await this.parseCommands(pluginPath, pluginName);

      // Skills and Agents are NOT parsed here to avoid duplicate scanning.
      // PowerManager.scanAllAgents() and loadSkillsFromPlugins() are the single
      // authoritative source for these capabilities. The plugin dialog reads
      // counts from the real registries (skillRegistry, agentRegistry, mcpService)
      // via the 'plugin:get-real-counts' IPC handler.
      const skills: SkillDefinition[] = [];
      const agents: AgentDefinition[] = [];

    // Hook 系统已移除，parseHooks 为兼容占位（恒返回 []）
    const hooks = await this.parseHooks(pluginPath, pluginName);

    // Parse MCP servers configuration
    const mcpServers = await this.parseMcpServers(pluginPath, pluginName);

    // Determine source from directory naming convention: {name}@github, {name}@gitee, {name}@gitlab, or {name}@local
    const dirName = path.basename(pluginPath);
    const source = dirName.endsWith('@github') ? 'github'
      : dirName.endsWith('@gitee') ? 'gitee'
      : dirName.endsWith('@gitlab') ? 'gitlab'
      : 'local';

    const loadedPlugin: LoadedPlugin = {
      name: pluginName,
      source,
      path: pluginPath,
      manifest,
      enabled: true,
      isBuiltin: false,
      commands,
        skills,
        agents,
      hooks,
      mcpServers,
    };

    // Register the plugin with the registry
    this.registry.register(loadedPlugin);

    return loadedPlugin;
  }

  /**
   * Load all plugins from a plugins directory (并行加载)
   * @param pluginsDir - Absolute path to the plugins directory
   * @returns Array of loaded plugins
   */
  async loadAllPlugins(pluginsDir: string): Promise<LoadedPlugin[]> {
    try {
      await fsPromises.access(pluginsDir)
    } catch {
      return [];
    }

    const entries = await fsPromises.readdir(pluginsDir, { withFileTypes: true });
    const pluginDirs = entries.filter(e => e.isDirectory())

    // 并行加载所有插件
    const loadPromises = pluginDirs.map(async (entry) => {
      const pluginPath = path.join(pluginsDir, entry.name);

      // Only process directories that have a valid manifest
      // (loadPlugin handles both .claude-plugin/plugin.json and plugin.json)
      const claudePluginManifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');
      const rootManifestPath = path.join(pluginPath, 'plugin.json');

      let hasManifest = false;
      try {
        await fsPromises.access(claudePluginManifestPath)
        hasManifest = true;
      } catch {
        try {
          await fsPromises.access(rootManifestPath)
          hasManifest = true;
        } catch {
          // no manifest
        }
      }

      if (!hasManifest) {
        return null;
      }

      try {
        const plugin = await this.loadPlugin(pluginPath);
        return plugin;
      } catch {
        return null;
      }
    })

    const results = await Promise.all(loadPromises)
    return results.filter((p): p is LoadedPlugin => p !== null)
  }

  /**
   * Parse commands from .md files in the commands directory
   */
  private async parseCommands(pluginPath: string, pluginName: string): Promise<CommandDef[]> {
    const commandsDir = path.join(pluginPath, 'commands');
    const commands: CommandDef[] = [];

    try {
      await fsPromises.access(commandsDir)
    } catch {
      return commands;
    }

    const files = await fsPromises.readdir(commandsDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));

    // 并行读取所有命令文件
    const commandPromises = mdFiles.map(async (file) => {
      const filePath = path.join(commandsDir, file);
      const commandId = `${pluginName}:${path.basename(file, '.md')}`;

      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        const { data, content: body } = matter(content);

        const command: CommandDef = {
          id: commandId,
          name: data.name || path.basename(file, '.md'),
          description: data.description,
          args: this.parseArgs(data.args),
          content: body.trim(),
          filePath,
        };

        return command;
      } catch {
        return null;
      }
    })

    const results = await Promise.all(commandPromises)
    return results.filter((c): c is CommandDef => c !== null)
  }

    /**
     * Recursively collect all .md file paths under a directory (异步版本)
     */
    private async collectMdFiles(dir: string): Promise<string[]> {
        const results: string[] = [];

        try {
            await fsPromises.access(dir)
        } catch {
            return results;
        }

        const entries = await fsPromises.readdir(dir, {withFileTypes: true});

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const subFiles = await this.collectMdFiles(fullPath);
                results.push(...subFiles);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                results.push(fullPath);
            }
        }

        return results;
    }

    /**
     * Parse skills from .md files in the skills directory (recursive, 并行)
     */
    private async parseSkills(pluginPath: string, _pluginName: string): Promise<SkillDefinition[]> {
        const skillsDir = path.join(pluginPath, 'skills');
        const mdFiles = await this.collectMdFiles(skillsDir);

        // 并行读取所有技能文件
        const skillPromises = mdFiles.map(async (filePath) => {
            try {
                const content = await fsPromises.readFile(filePath, 'utf-8');
                const {data} = matter(content);

                const skill: SkillDefinition = {
                    name: data.name || path.basename(filePath, '.md'),
                    description: data.description || '',
                    filePath,
                    allowedTools: data.allowedTools,
                    userInvocable: data.userInvocable ?? true,
                };

                return skill;
            } catch {
                return null;
            }
        })

        const results = await Promise.all(skillPromises)
        return results.filter((s): s is SkillDefinition => s !== null)
    }

    /**
     * Parse agents from .md files in the agents directory (recursive, 并行)
     */
    private async parseAgents(pluginPath: string, _pluginName: string): Promise<AgentDefinition[]> {
        const agentsDir = path.join(pluginPath, 'agents');
        const mdFiles = await this.collectMdFiles(agentsDir);

        // 并行读取所有 agent 文件
        const agentPromises = mdFiles.map(async (filePath) => {
            try {
                const content = await fsPromises.readFile(filePath, 'utf-8');
                const {data} = matter(content);

                const agent: AgentDefinition = {
                    name: data.name || path.basename(filePath, '.md'),
                    description: data.description || '',
                    filePath,
                    type: data.type,
                };

                return agent;
            } catch {
                return null;
            }
        })

        const results = await Promise.all(agentPromises)
        return results.filter((a): a is AgentDefinition => a !== null)
    }

  /**
   * Parse args from YAML frontmatter data
   */
  private parseArgs(argsData: unknown): ArgumentDef[] | undefined {
    if (!argsData) {
      return undefined;
    }

    if (Array.isArray(argsData)) {
      return argsData.map((arg) => {
        if (typeof arg === 'string') {
          return { name: arg };
        }
        return arg as ArgumentDef;
      });
    }

    return undefined;
  }

  /**
   * Hook 系统已移除：插件自带 hooks/hooks.json 被静默忽略，
   * skills/agents/commands/mcpServers 解析不受影响
   */
  private async parseHooks(_pluginPath: string, _pluginName: string): Promise<Record<string, unknown>[]> {
    return []
  }

  /**
   * Parse MCP servers configuration from mcp/servers.json
   */
  private async parseMcpServers(pluginPath: string, _pluginName: string): Promise<McpServerConfig[]> {
    const mcpPath = path.join(pluginPath, 'mcp', 'servers.json');

    try {
      await fsPromises.access(mcpPath)
    } catch {
      return [];
    }

    try {
      const content = await fsPromises.readFile(mcpPath, 'utf-8');
      const serversData = jsYaml.load(content);

      if (!serversData || typeof serversData !== 'object') {
        return [];
      }

      if (Array.isArray(serversData)) {
        return serversData as McpServerConfig[];
      }

      return [];
    } catch {
      return [];
    }
  }
}
