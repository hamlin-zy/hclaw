import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import yaml from 'js-yaml'
import {getHclawDir} from '../config'
import {getDatabase} from '../repositories/sqlite'
import {PluginRegistry} from '../plugin/registry'
import type {AgentTemplate} from '@shared/types'
import {buildAgentTemplateFromRaw, type RawAgentConfig} from './utils/configExtractor'
import {logger} from './logger'
import {addAgentLoadError, resetAgentLoadErrors} from './agentLoadErrors'

/**
 * 本地 Agent 加载器
 *
 * 扫描以下目录并解析 Agent 定义：
 * - ~/.hclaw/agents/ (主目录)
 * - ~/.hclaw/plugins/{plugin}/agents/ (插件内的 agents 目录)
 * - ~/.hclaw/plugins/{plugin}/.agents/ (插件内的 .agents 目录)
 *
 * 支持三种文件格式：
 * 1. Markdown 文件 (.md) - YAML frontmatter + 正文作为 systemPrompt
 * 2. JSON 文件 (.json)
 * 3. YAML 文件 (.yaml/.yml)
 *
 * 支持递归扫描子目录
 */

// Agent 扫描目录
const AGENTS_DIR = path.join(getHclawDir(), 'agents')
const PLUGINS_DIR = path.join(getHclawDir(), 'plugins')

const SUPPORTED_EXTENSIONS = new Set(['.md'])
const SKIPPED_FILES = new Set(['readme.md', 'contributing.md', 'contributing_zh-cn.md', 'license', 'executive-brief.md', 'quickstart.md', 'agents.md', 'readme', 'skill.md'])
const SKIPPED_DIRS = new Set(['.git', '.github', 'scripts', 'node_modules', 'docs', 'tests', 'schemas', 'site', 'reference', 'references'])

interface FileEntry {
    filePath: string
    relativePath: string
}

/**
 * 扫描配置选项
 */
interface ScanOptions {
    /** 来源类型 */
    source: 'local' | 'plugin'

    /** 插件启用状态（仅 plugin 来源使用） */
    pluginEnabled?: boolean

    /** ID 前缀 */
    idPrefix?: string

    /** 额外的标签 */
    extraTags?: string[]
}

// ─── 核心解析函数 ──────────────────────────────────────────

/**
 * 解析 Markdown 文件中的 YAML frontmatter
 * 格式:
 * ---
 * name: Agent Name
 * description: Agent description
 * tools: [tool1, tool2]
 * ---
 * System prompt content here...
 */
function parseMarkdownFrontmatter(content: string): {
    frontmatter: Record<string, unknown>
    bodyContent: string
} | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) return null

    try {
        const frontmatter = yaml.load(match[1]) as Record<string, unknown>
        const bodyContent = match[2].trim()
        return {frontmatter, bodyContent}
    } catch (err) {
        logger.debug('[AgentLoader] failed to parse YAML frontmatter', {error: err})
        return null
    }
}

/**
 * 从文件内容解析 agent 配置
 */
function parseAgentFile(content: string, ext: string): {
    raw: Record<string, unknown>
    systemPrompt: string
} | null {
    if (ext === '.md') {
        const parsed = parseMarkdownFrontmatter(content)
        if (!parsed) return null
        return {raw: parsed.frontmatter, systemPrompt: parsed.bodyContent}
    }

    let raw: Record<string, unknown>
    try {
        raw = ext === '.json'
            ? JSON.parse(content)
            : yaml.load(content) as Record<string, unknown>
    } catch (err) {
        logger.debug('[AgentLoader] failed to parse agent file', {ext, error: err})
        return null
    }

    const systemPrompt = (raw.system_prompt as string)
        || (raw.instructions as string)
        || (raw.prompt as string)
        || ''

    return {raw, systemPrompt}
}

/**
 * 递归扫描目录，收集所有候选文件
 */
async function walkDir(dir: string): Promise<FileEntry[]> {
    const results: FileEntry[] = []

    async function walk(currentDir: string): Promise<void> {
        try {
            await fsPromises.access(currentDir)
        } catch {
            return
        }

        const entries = await fsPromises.readdir(currentDir, {withFileTypes: true})

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (SKIPPED_DIRS.has(entry.name)) continue
                await walk(path.join(currentDir, entry.name))
            } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                const fullPath = path.join(currentDir, entry.name)
                results.push({
                    filePath: fullPath,
                    relativePath: path.relative(dir, fullPath) // 使用传入的 dir 作为基准
                })
            }
        }
    }

    await walk(dir)
    return results
}

/**
 * 检查文件是否应该被跳过
 */
function shouldSkipFile(filePath: string, relativePath: string): boolean {
    const baseName = path.basename(filePath).toLowerCase()
    if (SKIPPED_FILES.has(baseName)) {
        return true
    }
    // 排除 SKILL 定义文件（任意扩展名），防止被当作 Agent 误解析
    if (path.parse(filePath).name.toLowerCase() === 'skill') {
        return true
    }
    if (relativePath.startsWith('scripts' + path.sep) || relativePath.startsWith('scripts/')) {
        return true
    }
    return false
}

// ─── 统一的文件扫描函数 ──────────────────────────────────────

/**
 * 从单个目录扫描并解析所有 agent 文件
 *
 * @param dir 目录路径
 * @param options 扫描选项
 * @returns 解析后的 AgentTemplate 数组
 */
async function scanAgentDirectory(
    dir: string,
    options: ScanOptions,
): Promise<AgentTemplate[]> {
    const {source, pluginEnabled = true, idPrefix = '', extraTags = []} = options
    const templates: AgentTemplate[] = []

    try {
        const files = await walkDir(dir)

        for (const {filePath, relativePath} of files) {
            if (shouldSkipFile(filePath, relativePath)) {
                continue
            }

            try {
                const content = await fsPromises.readFile(filePath, 'utf-8')
                const ext = path.extname(filePath).toLowerCase()

                // 对于 .md 文件，快速检查是否包含 frontmatter（以 --- 开头）
                // 不包含则不是 agent 定义文件，直接跳过，不报告错误
                if (ext === '.md' && !content.startsWith('---')) {
                    continue
                }

                const parsed = parseAgentFile(content, ext)
                if (!parsed) {
                    addAgentLoadError(filePath, 'Agent 文件解析失败，请检查 YAML frontmatter 格式', path.basename(filePath, ext))
                    continue
                }

                // 生成 ID：使用相对路径（不含扩展名）
                const id = `${idPrefix}${relativePath.replace(/\.(md|json|yaml|yml)$/, '')}`
                const defaultName = path.basename(filePath, ext)

                const template = buildAgentTemplateFromRaw(
                    id,
                    parsed.raw as RawAgentConfig,
                    parsed.systemPrompt,
                    {
                        defaultName,
                        source,
                        pluginEnabled,
                    },
                )

                if (template) {
                    // 添加额外的标签
                    if (extraTags.length > 0) {
                        template.tags = [...(template.tags || []), ...extraTags]
                    }
                    templates.push(template)
                } else {
                    addAgentLoadError(filePath, 'Agent 配置不完整，请检查 name/description 等必要字段', defaultName)
                }
            } catch (err) {
                logger.debug('[AgentLoader] failed to parse agent file', {
                    filePath,
                    error: err instanceof Error ? err.message : String(err)
                })
                addAgentLoadError(filePath, `Agent 文件加载异常: ${err instanceof Error ? err.message : String(err)}`)
            }
        }
    } catch (err) {
        logger.debug('[AgentLoader] failed to scan directory', {
            dir,
            error: err instanceof Error ? err.message : String(err)
        })
        addAgentLoadError(dir, `Agent 目录扫描异常: ${err instanceof Error ? err.message : String(err)}`)
    }

    return templates
}

/**
 * 从插件根目录查找所有名称含 "agent" 的目录
 * （仅扫描一级，递归扫描由 scanAgentDirectory 负责）
 */
async function getPluginAgentDirs(
    pluginPath: string,
): Promise<{dir: string; prefix: string}[]> {
    const dirs: {dir: string; prefix: string}[] = []

    try {
        const entries = await fsPromises.readdir(pluginPath, {withFileTypes: true})

        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            if (SKIPPED_DIRS.has(entry.name)) continue         // 跳过黑名单目录
            if (!/agent/i.test(entry.name)) continue           // 目录名必须含 "agent"
            if (entry.name.startsWith('.') && entry.name !== '.agents') continue  // 仅允许 .agents 作为特例

            const fullPath = path.join(pluginPath, entry.name)
            dirs.push({dir: fullPath, prefix: `${entry.name}/`})
        }
    } catch {
        // 目录不存在或无权限
    }

    return dirs
}

/**
 * 按目录路径查找插件（而非按 name，因为目录名 ≠ manifest.name）
 */
function findPluginByPath(pluginPath: string) {
    return PluginRegistry.getInstance().getAll().find(
        p => path.resolve(p.path) === path.resolve(pluginPath),
    )
}

// ─── 导出函数 ──────────────────────────────────────────────

/**
 * 扫描本地 agents 目录
 *
 * 扫描以下目录：
 * - ~/.hclaw/agents/ (主目录)
 */
export async function scanLocalAgents(): Promise<AgentTemplate[]> {
    const allTemplates: AgentTemplate[] = []

    // 仅扫描 ~/.hclaw/agents/ 目录
    if (!fs.existsSync(AGENTS_DIR)) {
        fs.mkdirSync(AGENTS_DIR, {recursive: true})
        logger.debug('[AgentLoader] created agents directory', {dir: AGENTS_DIR})
    } else {
        const templates = await scanAgentDirectory(AGENTS_DIR, {
            source: 'local',
            idPrefix: '',
            extraTags: ['source:hclaw'],
        })
        allTemplates.push(...templates)
    }

    logger.debug('[AgentLoader] scanned local agents', {
        count: allTemplates.length,
    })

    return allTemplates
}

/**
 * 根据相对路径查找 Agent 文件（尝试多种扩展名）
 */
export async function findAgentFile(
    relativePath: string,
    agentsDir: string,
): Promise<string | null> {
    const extensions = ['.md']
    for (const ext of extensions) {
        const candidate = path.join(agentsDir, relativePath + ext)
        try {
            await fsPromises.access(candidate)
            return candidate
        } catch {
            // 文件不存在，尝试下一个
        }
    }
    return null
}

/**
 * 从指定插件扫描 agent 定义
 *
 * 扫描以下目录：
 * - ~/.hclaw/plugins/{pluginName}/agents/ (标准目录)
 * - ~/.hclaw/plugins/{pluginName}/.agents/ (Claude Code 插件结构)
 */
export async function scanAgentsFromPlugin(
    pluginName: string,
): Promise<{templates: AgentTemplate[]; sourceDir: string}> {
    const pluginPath = path.join(PLUGINS_DIR, pluginName)

    // 获取插件的 agents 目录（按目录名含 "agent" 匹配）
    const agentDirs = await getPluginAgentDirs(pluginPath)

    if (agentDirs.length === 0) {
        return {templates: [], sourceDir: pluginPath}
    }

    // 获取插件启用状态（按目录路径查找，因为目录名 ≠ manifest.name）
    const plugin = findPluginByPath(pluginPath)
    const pluginEnabled = plugin?.enabled ?? false

    const allTemplates: AgentTemplate[] = []

    for (const {dir, prefix} of agentDirs) {
        const templates = await scanAgentDirectory(dir, {
            source: 'plugin',
            pluginEnabled,
            idPrefix: `${pluginName}:${prefix}`,
            extraTags: [`plugin:${pluginName}`, `source:${prefix.replace(/\/$/, '')}`],
        })

        allTemplates.push(...templates)
    }

    logger.debug('[AgentLoader] scanned plugin agents', {
        pluginName,
        count: allTemplates.length,
        enabled: pluginEnabled,
        agentDirs: agentDirs.map(d => d.dir),
    })

    return {templates: allTemplates, sourceDir: pluginPath}
}

/**
 * 从所有插件扫描 agent 定义
 *
 * 复用 scanAgentsFromPlugin() 避免重复的目录扫描逻辑。
 * 仅返回已启用插件的 agents。
 */
export async function scanAgentsFromPlugins(): Promise<
    {templates: AgentTemplate[]; sourceDir: string}[]
> {
    try {
        await fsPromises.access(PLUGINS_DIR)
    } catch {
        return []
    }

    try {
        const entries = await fsPromises.readdir(PLUGINS_DIR, {withFileTypes: true})

        // 并行扫描所有插件（复用 scanAgentsFromPlugin 避免重复逻辑）
        const scanResults = await Promise.all(
            entries
                .filter(e => e.isDirectory())
                .map(async (entry) => {
                    const result = await scanAgentsFromPlugin(entry.name)
                    if (result.templates.length === 0) return null

                    // 按目录路径匹配插件
                    const plugin = findPluginByPath(path.join(PLUGINS_DIR, entry.name))
                    if (!plugin?.enabled) return null

                    return result
                }),
        )

        const results = scanResults.filter(Boolean) as { templates: AgentTemplate[]; sourceDir: string }[]

        logger.debug('[AgentLoader] scanned all plugins', {
            pluginCount: results.length,
            totalAgents: results.reduce((sum, r) => sum + r.templates.length, 0),
        })

        return results
    } catch (err) {
        logger.debug('[AgentLoader] failed to scan plugins directory', {
            error: err instanceof Error ? err.message : String(err),
        })
        return []
    }
}

// ─── Agent 覆盖状态持久化（SQLite） ───────────────────────────
// 用户可通过 UI 切换插件 Agent 的启用状态，该覆盖保存在 agent_overrides 表中，
// 不被插件更新影响。

interface AgentOverrides {
    [agentId: string]: {
        enabled: boolean
        updatedAt: number
    }
}

function readAgentOverridesSync(): AgentOverrides {
    try {
        const db = getDatabase()
        const rows = db.prepare('SELECT agent_id, enabled, updated_at FROM agent_overrides').all() as Array<{
            agent_id: string
            enabled: number
            updated_at: number
        }>
        const overrides: AgentOverrides = {}
        for (const row of rows) {
            overrides[row.agent_id] = {enabled: row.enabled === 1, updatedAt: row.updated_at}
        }
        return overrides
    } catch {
        return {}
    }
}

/**
 * 扫描所有 agent（本地 + 插件），并自动应用 agents.json 中的用户覆盖
 */
export async function scanAllAgents(): Promise<AgentTemplate[]> {
    logger.debug('[AgentLoader] scanAllAgents: starting...')

    // 清空上个扫描周期的加载错误
    resetAgentLoadErrors()

    // 扫描本地 agents
    const localTemplates = await scanLocalAgents()
    logger.debug('[AgentLoader] scanAllAgents: localTemplates', {count: localTemplates.length})

    // 扫描插件 agents
    const pluginResults = await scanAgentsFromPlugins()
    const pluginTemplates = pluginResults.flatMap(r => r.templates)
    logger.debug('[AgentLoader] scanAllAgents: pluginResults', {
        pluginCount: pluginResults.length,
        pluginTemplates: pluginTemplates.length,
    })

    // 统计每个插件的 agents（sourceDir 是插件目录路径）
    const agentsByPlugin: Record<string, number> = {}
    pluginResults.forEach(r => {
        if (r.templates.length > 0) {
            const pluginDir = path.basename(r.sourceDir)
            agentsByPlugin[pluginDir] = (agentsByPlugin[pluginDir] || 0) + r.templates.length
        }
    })

    if (Object.keys(agentsByPlugin).length > 0) {
        logger.debug('[AgentLoader] scanAllAgents: agentsByPlugin', agentsByPlugin)
    }

    const allTemplates = [...localTemplates, ...pluginTemplates]

    // 应用 agent_overrides 中的用户覆盖（对所有 Agent 生效，不限于插件）
    // 但已禁用插件的 Agent 强制 disabled，覆盖不生效
    const overrides = readAgentOverridesSync()
    const disabledPlugins = PluginRegistry.getInstance().getDisabledNames()

    // 无覆盖且无禁用插件 → 无需遍历
    if (Object.keys(overrides).length === 0 && disabledPlugins.size === 0) return allTemplates

    let appliedCount = 0
    for (const template of allTemplates) {
        // 已禁用插件的 Agent 强制 disabled（通过 tags 中 plugin:xxx 提取插件名）
        const pluginTag = template.tags?.find(t => t.startsWith('plugin:'))
        if (pluginTag) {
            const pluginName = pluginTag.replace('plugin:', '')
            if (disabledPlugins.has(pluginName)) {
                template.enabled = false
                continue
            }
        }
        const override = overrides[template.id]
        if (override !== undefined) {
            template.enabled = override.enabled
            appliedCount++
        }
    }

    if (appliedCount > 0) {
        logger.debug('[AgentLoader] scanAllAgents: applied overrides', {count: appliedCount})
    }

    logger.debug('[AgentLoader] scanAllAgents: total', {count: allTemplates.length})

    // 清理不再存在的插件 Agent 覆盖记录
    const validPluginIds = new Set(allTemplates.filter(t => t.tags?.some(tag => tag.startsWith('plugin:'))).map(t => t.id))
    await cleanStalePluginOverrides(validPluginIds)

    return allTemplates
}

/**
 * 更新插件 Agent 的覆盖状态（写入 agents.json）
 * 用于 agents:update IPC handler 不支持直接修改插件文件时的降级方案
 */
export async function updatePluginAgentOverride(agentId: string, enabled: boolean): Promise<void> {
    try {
        const db = getDatabase()
        const now = Date.now()
        db.prepare('INSERT OR REPLACE INTO agent_overrides (agent_id, enabled, updated_at) VALUES (?, ?, ?)')
            .run(agentId, enabled ? 1 : 0, now)
        logger.debug('[AgentLoader] updatePluginAgentOverride', {agentId, enabled})
    } catch (err) {
        logger.error('[AgentLoader] updatePluginAgentOverride failed', {agentId, error: (err as Error).message})
    }
}

/**
 * 清理不再存在的插件 Agent 的覆盖状态（避免垃圾数据堆积）
 */
export async function cleanStalePluginOverrides(validPluginAgentIds: Set<string>): Promise<void> {
    try {
        if (validPluginAgentIds.size === 0) return
        const db = getDatabase()
        const placeholders = Array(validPluginAgentIds.size).fill('?').join(',')
        const result = db.prepare(`DELETE FROM agent_overrides WHERE agent_id NOT IN (${placeholders})`).run(...validPluginAgentIds)
        if (result.changes > 0) {
            logger.debug('[AgentLoader] cleanStalePluginOverrides: cleaned', {count: result.changes})
        }
    } catch (err) {
        logger.error('[AgentLoader] cleanStalePluginOverrides failed', {error: (err as Error).message})
    }
}

