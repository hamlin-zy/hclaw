/**
 * Skills 加载器
 *
 * 从文件系统扫描和加载 SKILL.md 技能定义。
 *
 * 技能发现流程：
 * 1. 扫描 ~/.hclaw/skills/public/ 和 ~/.hclaw/skills/custom/
 * 2. 扫描 ~/.agents/skills/ (用户主目录下的 .agents 技能目录)
 * 3. 扫描 ~/.hclaw/plugins/{pluginName}/skills/ 插件技能目录
 * 4. 扫描 ~/.hclaw/plugins/{pluginName}/.agents/skills/ (Claude Code 插件结构)
 * 5. 解析每个子目录下的 SKILL.md
 * 6. 提取 YAML frontmatter + Markdown 正文
 * 7. 扫描扩展目录（references/, scripts/, templates/, agents/, assets/）
 * 8. 注册到 SkillRegistry
 *
 * 容错策略：
 * - 使用 js-yaml 解析完整 YAML 结构（支持嵌套对象）
 * - 缺失字段自动注入默认值（enabled 默认 true）
 * - 单文件解析失败不阻塞其他技能加载
 * - 扩展目录扫描失败不阻塞技能加载
 */

import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import type {SkillDefinition} from './types'
import {skillRegistry} from './registry'
import {scanSkillExtensions} from './extensions'
import {getHclawDir} from '../../config'
import {PluginRegistry} from '../../plugin/registry'
import {logger} from '../logger'
import {getDatabase} from '../../repositories/sqlite'
import {addLoadError, resetLoadErrors} from './loadErrors'

const SKILL_FILE = 'SKILL.md'

// ─── 默认值配置 ──────────────────────────────────────

const DEFAULT_SKILL_VERSION = '1.0.0'

// Skills 扫描目录
const HOME_AGENTS_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills')

// 递归扫描时跳过的黑名单目录
const SKIP_DIRS = new Set(['docs', 'tests', 'node_modules', '.git', '.github', 'schemas', 'scripts', 'site'])

// ─── 辅助：递归查找插件技能目录 ──────────────────────

/**
 * 从插件根目录递归查找所有技能目录（包含 SKILL.md 的子目录）
 *
 * 规则：
 * - 跳过 . 开头的隐藏目录
 * - 跳过黑名单目录（docs/、tests/、node_modules/ 等）
 * - 子目录中有 SKILL.md 即视为技能目录
 */
async function findPluginSkillDirs(pluginPath: string): Promise<string[]> {
    const skillDirs: string[] = []

    async function walk(dir: string): Promise<void> {
        try {
            const entries = await fsPromises.readdir(dir, {withFileTypes: true})
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue        // 跳过隐藏目录
                if (SKIP_DIRS.has(entry.name)) continue         // 跳过黑名单目录
                if (!entry.isDirectory()) continue

                const fullPath = path.join(dir, entry.name)
                const skillFile = path.join(fullPath, SKILL_FILE)

                try {
                    await fsPromises.access(skillFile)
                    skillDirs.push(fullPath)  // 是技能目录
                } catch {
                    await walk(fullPath)      // 递归深入
                }
            }
        } catch {
            // 无权限等静默跳过
        }
  }

    await walk(pluginPath)
    return skillDirs
}

// ─── 主加载函数 ──────────────────────────────────────

/**
 * 从目录加载所有技能
 * @param skillsDir 技能根目录（默认 ~/.hclaw/skills/）
 */
export async function loadSkillsFromDirectory(skillsDir?: string): Promise<number> {
  // 清空上个刷新周期的加载错误
  resetLoadErrors()

  const baseDir = skillsDir || getDefaultSkillsDir()
  let loaded = 0

  // 加载社区安装的技能（skills/public/）
  const publicDir = path.join(baseDir, 'public')
  if (fs.existsSync(publicDir)) {
    const count = await loadSkillsFromPath(publicDir, 'user')
    loaded += count
  }

  // 加载用户自定义技能
  const customDir = path.join(baseDir, 'custom')
  if (fs.existsSync(customDir)) {
    const count = await loadSkillsFromPath(customDir, 'user')
    loaded += count
  }

  // 加载 ~/.agents/skills/ 目录（Claude Code 风格）
  if (fs.existsSync(HOME_AGENTS_SKILLS_DIR)) {
    const count = await loadSkillsFromPath(HOME_AGENTS_SKILLS_DIR, 'user')
    loaded += count
  }

  return loaded
}

/**
 * 从单个技能目录读取 SKILL.md 并注册
 */
async function loadSkillDir(skillDir: string, pluginName: string, pluginEnabled: boolean): Promise<boolean> {
    try {
        const skillFile = path.join(skillDir, SKILL_FILE)
        const content = await fsPromises.readFile(skillFile, 'utf-8')
        const skillId = `${pluginName}:${path.basename(skillDir)}`
        const skill = parseSkillFile(content, skillId, 'plugin', skillFile, skillDir)
        if (!skill) return false
        return await registerPluginSkill(skill, skillDir, pluginName, pluginEnabled)
    } catch {
        return false
    }
}

/**
 * 从指定插件目录加载所有技能
 *
 * @param pluginName 插件名称
 * @returns 加载的技能数量
 */
export async function loadSkillsFromPluginDirectory(pluginName: string): Promise<number> {
  const pluginRegistry = PluginRegistry.getInstance()
  const plugin = pluginRegistry.get(pluginName)
  if (!plugin) return 0

    const skillDirs = await findPluginSkillDirs(plugin.path)
    if (skillDirs.length === 0) return 0

  let loaded = 0
    for (const skillDir of skillDirs) {
        if (await loadSkillDir(skillDir, plugin.name, plugin.enabled)) loaded++
    }
    return loaded
}

/**
 * 从所有已启用插件加载技能
 *
 * 扫描 ~/.hclaw/plugins/{pluginName}/skills/ 目录
 * 插件技能的 namespace 格式为 "{pluginName}:{skillName}"
 *
 * 注意：此函数直接扫描 ~/.hclaw/plugins/ 目录，与 scanAgentsFromPlugins() 保持一致。
 * 不依赖 PluginRegistry，因为 Worker 中的 PluginRegistry 是独立实例。
 */
export async function loadSkillsFromPlugins(): Promise<number> {
    const PLUGINS_DIR = path.join(getHclawDir(), 'plugins')

  logger.debug('[SkillsLoader]', {action: 'load-from-plugins-start', pluginsDir: PLUGINS_DIR})

  try {
    await fsPromises.access(PLUGINS_DIR)
  } catch {
    logger.debug('[SkillsLoader]', {action: 'plugins-dir-not-found'})
    return 0
  }

  let loaded = 0

  try {
    const entries = await fsPromises.readdir(PLUGINS_DIR, {withFileTypes: true})
    const pluginDirs = entries.filter(e => e.isDirectory())

    logger.debug('[SkillsLoader]', {action: 'found-plugins', count: pluginDirs.length, names: pluginDirs.map(e => e.name)})

    // 并行加载所有插件的技能
    const loadPromises = pluginDirs.map(async (entry) => {
      const pluginPath = path.join(PLUGINS_DIR, entry.name)
        const skillDirs = await findPluginSkillDirs(pluginPath)

        if (skillDirs.length === 0) {
        logger.debug('[SkillsLoader]', {action: 'plugin-no-skills-dir', plugin: entry.name})
        return 0
      }

        logger.debug('[SkillsLoader]', {action: 'found-skills-dirs', plugin: entry.name, count: skillDirs.length})

        // 获取插件的实际启用状态
        // IMPORTANT: 目录名可能和 manifest name 不一致（如 superpowers@github vs superpowers）
        // 必须按路径查找而不是按目录名查找
        const pluginRegistry = PluginRegistry.getInstance()
        const allPlugins = pluginRegistry.getAll()
        const plugin = allPlugins.find(p => p.path === pluginPath)
        const pluginEnabled = plugin?.enabled ?? false
        logger.debug('[SkillsLoader]', {action: 'plugin-lookup', dir: entry.name, path: pluginPath, pluginFound: !!plugin, manifestName: plugin?.name, pluginEnabled: plugin?.enabled, finalPluginEnabled: pluginEnabled})

      let pluginLoaded = 0
      try {
          for (const skillDir of skillDirs) {
              if (await loadSkillDir(skillDir, plugin?.name || entry.name, pluginEnabled)) pluginLoaded++
          }
      } catch (err: any) {
          logger.error('[SkillsLoader]', {action: 'load-from-plugin-error', plugin: entry.name, error: err?.message})
      }
      return pluginLoaded
    })

    const results = await Promise.all(loadPromises)
    loaded = results.reduce((sum, count) => sum + count, 0)
  } catch (err: any) {
    logger.error('[SkillsLoader]', {action: 'scan-plugins-dir-error', error: err?.message})
  }

  logger.debug('[SkillsLoader]', {action: 'total-loaded', loaded})
  return loaded
}

/**
 * 统一注册插件技能
 *
 * 所有插件技能都通过此函数注册，确保 enabled 逻辑在一处管理。
 *
 * @param skill 解析后的技能对象
 * @param skillDir 技能目录路径
 * @param pluginName 插件名称
 * @param pluginEnabled 插件启用状态
 * @returns 是否注册成功
 */
async function registerPluginSkill(
    skill: SkillDefinition,
    skillDir: string,
    pluginName: string,
    pluginEnabled: boolean,
): Promise<boolean> {
    try {
        const extensions = await scanSkillExtensions(skillDir)
        skill.extensions = extensions
        skill.skillDir = skillDir
        skill.source = 'plugin'
        skill.pluginName = pluginName
        // 插件技能的 enabled 统一跟随插件启用状态
        skill.enabled = pluginEnabled
        // 保存插件真实启用状态（独立于个体的 enabled，后者可能被 applySkillOverrides 覆盖）
        skill.pluginEnabled = pluginEnabled
        skillRegistry.register(skill)
        return true
    } catch (err: any) {
        logger.error('[SkillsLoader]', {action: 'register-skill-error', skillId: skill.id, error: err?.message})
        return false
    }
}

/**
 * 从指定插件路径加载单个插件技能
 *
 * @param pluginPath 插件根目录路径
 * @param skillName 技能目录名
 * @returns 加载的技能数量（0 或 1）
 */
export async function loadFromPlugin(pluginPath: string, skillName: string): Promise<number> {
  const pluginName = path.basename(pluginPath)
    const skillDirs = await findPluginSkillDirs(pluginPath)
    const skillDir = skillDirs.find(d => path.basename(d) === skillName)
    if (!skillDir) return 0

  const skillFile = path.join(skillDir, SKILL_FILE)

    // 获取插件的启用状态
    const pluginRegistry = PluginRegistry.getInstance()
    const plugin = pluginRegistry.get(pluginName)
    const pluginEnabled = plugin?.enabled ?? false

    const content = await fsPromises.readFile(skillFile, 'utf-8')
    const skillId = `${pluginName}:${skillName}`
    const skill = parseSkillFile(content, skillId, 'plugin', skillFile, skillDir)

    if (skill) {
        const success = await registerPluginSkill(skill, skillDir, pluginName, pluginEnabled)
        if (success) {
      return 1
    }
  }

  return 0
}

/**
 * 从指定路径扫描子目录中的 SKILL.md
 *
 * 递归扫描支持 DeerFlow 风格的多级技能目录结构。
 * 同时支持 SKILL.md 文件直接在目录下的情况。
 */
async function loadSkillsFromPath(
  dir: string,
  source: 'builtin' | 'user',
  basePath?: string,
): Promise<number> {
  let loaded = 0
  const base = basePath || dir
    const _sourceLabel = source === 'builtin' ? '内置' : '用户'

  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      const dirName = path.basename(dir)

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      // 跳过隐藏目录和文件
      if (entry.name.startsWith('.')) continue

      if (entry.isFile()) {
        // 检查是否是直接放在目录下的 SKILL.md 文件
        if (entry.name === SKILL_FILE) {
          try {
            const content = await fsPromises.readFile(fullPath, 'utf-8')
            // 使用目录名作为 skill id
            const skillId = dirName || 'skill'
            const skill = parseSkillFile(content, skillId, source, fullPath, dir)

            if (skill) {
              const extensions = await scanSkillExtensions(dir)
              skill.extensions = extensions
              skill.skillDir = dir

              skillRegistry.register(skill)
              loaded++
            } else {
              logger.warn('[SkillsLoader]', {action: 'parse-skill-file-returned-null', skillFile: fullPath})
              addLoadError(dir, fullPath, 'SKILL.md 解析失败，请检查 YAML frontmatter 格式')
            }
          } catch (err: any) {
            logger.warn('[SkillsLoader]', {action: 'load-skill-file-error', skillFile: fullPath, error: err?.message})
            addLoadError(dir, fullPath, `SKILL.md 加载异常: ${err?.message}`)
          }
        }
        // 普通文件，跳过
        continue
      }

      if (entry.isDirectory()) {
        // 检查是否是技能目录（有 SKILL.md）
        const skillFile = path.join(fullPath, SKILL_FILE)

        try {
          await fsPromises.access(skillFile)
        } catch {
          // 不是技能目录，继续递归
          const subLoaded = await loadSkillsFromPath(fullPath, source, base)
          loaded += subLoaded
          continue
        }

        // 是技能目录，加载它
        try {
          const content = await fsPromises.readFile(skillFile, 'utf-8')
          // 使用相对于 base 的路径作为 skill id
          const relativePath = path.relative(base, fullPath)
          const skillId = relativePath.replace(/[/\\]/g, '-')
          const skill = parseSkillFile(content, skillId, source, skillFile, fullPath)

          if (skill) {
            // 扫描扩展目录（现在是 async）
            const extensions = await scanSkillExtensions(fullPath)
            skill.extensions = extensions
            skill.skillDir = fullPath

            skillRegistry.register(skill)
            loaded++
          } else {
            logger.warn('[SkillsLoader]', {action: 'parse-skill-dir-returned-null', skillDir: fullPath})
            addLoadError(fullPath, skillFile, 'SKILL.md 解析失败，请检查 YAML frontmatter 格式')
          }
        } catch (err: any) {
          logger.warn('[SkillsLoader]', {action: 'load-skill-dir-error', skillDir: fullPath, error: err?.message})
          addLoadError(fullPath, skillFile, `SKILL.md 加载异常: ${err?.message}`)
        }
      }
    }
  } catch (err: any) {
    logger.warn('[SkillsLoader]', {action: 'load-skills-from-path-error', dir, error: err?.message})
    addLoadError(dir, dir, `技能目录扫描异常: ${err?.message}`)
  }

  return loaded
}

// ─── 序列化 ──────────────────────────────────────────

/**
 * 将 SkillDefinition 序列化为普通对象（用于 IPC 传输）
 *
 * 提取此函数以消除 agent/index.ts 中的重复代码。
 */
export function serializeSkill(skill: SkillDefinition): Record<string, unknown> {
    // 如果是插件技能，获取插件的实际启用状态（独立于技能个体的 enabled 覆盖）
    let pluginEnabled: boolean | undefined
    if (skill.pluginName) {
        const pluginRegistry = PluginRegistry.getInstance()
        const plugin = pluginRegistry.get(skill.pluginName)
        pluginEnabled = plugin?.enabled ?? false
    }
    return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        userDescription: skill.userDescription,
        version: skill.version,
        enabled: skill.enabled,
        source: skill.source,
        pluginName: skill.pluginName,
        pluginEnabled,
        allowedTools: skill.allowedTools,
        content: skill.content,
        filePath: skill.filePath,
        skillDir: skill.skillDir,
        loadedAt: skill.loadedAt,
    }
}

/** 批量序列化技能列表 */
export function serializeSkills(skills: SkillDefinition[]): Record<string, unknown>[] {
    return skills.map(serializeSkill)
}

/** 获取并清空本轮技能扫描的加载错误列表 */
export { getAndClearLoadErrors } from './loadErrors'

// ─── 解析器 ──────────────────────────────────────────

/**
 * 解析 SKILL.md 文件
 *
 * 格式：
 * ```
 * ---
 * name: 技能名称
 * description: 技能描述
 * version: "1.0.0"
 * enabled: true       # 可选，默认 true
 * context: inline     # 可选：inline, fork, reference, script
 * allowed_tools:      # 可选
 *   - file_read
 *   - glob
 * dependency:          # 可选：依赖检查
 *   nodejs: ">=18.0.0"
 * ---
 *
 * ## Instructions
 * 技能的具体指令内容...
 * ```
 * 
 * @param content 文件内容
 * @param skillId 技能 ID
 * @param source 来源（builtin/user/plugin）
 * @param filePath 文件路径
 * @param skillDir 技能目录路径（可选）
 */
function parseSkillFile(
  content: string,
  skillId: string,
  source: 'builtin' | 'user' | 'plugin',
  filePath: string,
  skillDir?: string,
): SkillDefinition | null {
  // 提取 YAML frontmatter
  // 支持 Windows (\r\n) 和 Unix (\n) 换行符
  const frontmatterMatch = content.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/m)
  if (!frontmatterMatch) {
    return null
  }

  const frontmatterText = frontmatterMatch[1]
  const bodyContent = content.slice(frontmatterMatch[0].length).trim()

  // 使用 js-yaml 解析（支持嵌套对象、多行文本、各种 YAML 特性）
  let fm: Record<string, unknown>
  try {
    const parsed = yaml.load(frontmatterText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    fm = parsed as Record<string, unknown>
  } catch (err: any) {
    logger.warn('[SkillsLoader]', {action: 'parse-yaml-error', skillId, filePath, error: err?.message})
    addLoadError(path.dirname(filePath), filePath, `YAML 解析错误: ${err?.message}`)
    return null
  }

  // ── 字段校验与默认值注入 ──

  // name: 必填
  if (!fm.name || typeof fm.name !== 'string') {
    return null
  }

  // description: 可选，默认空
  const description = typeof fm.description === 'string' ? fm.description : ''

  // user_description: 可选，用户自定义描述（优先用于系统提示词）
  const userDescription = typeof fm.user_description === 'string' ? fm.user_description : undefined

  // version: 可选，默认 1.0.0
  const version = typeof fm.version === 'string' ? fm.version : DEFAULT_SKILL_VERSION

    // enabled: 可选，默认 true
    // 插件技能默认 true（因为只有已启用的插件才会被扫描加载）
    // 本地技能默认 true
    const enabled = typeof fm.enabled === 'boolean' ? fm.enabled : true

  // allowed_tools: 可选，应该是字符串数组
  let allowedTools: string[] | undefined
  if (fm.allowed_tools !== undefined) {
    if (Array.isArray(fm.allowed_tools)) {
      allowedTools = (fm.allowed_tools as unknown[]).filter((t): t is string => typeof t === 'string')
    } else if (typeof fm.allowed_tools === 'string') {
      // 支持逗号分隔的字符串格式
      allowedTools = fm.allowed_tools.split(',').map(s => s.trim()).filter(Boolean)
    }
  }

  // context: 可选，验证是否为有效值（支持 inline, fork, reference, script）
  let context: 'inline' | 'fork' | 'reference' | 'script' | undefined
  const validContexts = ['inline', 'fork', 'reference', 'script']
  if (fm.context && typeof fm.context === 'string' && validContexts.includes(fm.context)) {
    context = fm.context as 'inline' | 'fork' | 'reference' | 'script'
  }

  // dependency: 可选，依赖配置
  let dependency: SkillDefinition['dependency'] | undefined
  if (fm.dependency && typeof fm.dependency === 'object') {
    const dep = fm.dependency as Record<string, unknown>
    dependency = {
      nodejs: typeof dep.nodejs === 'string' ? dep.nodejs : undefined,
      python: typeof dep.python === 'string' ? dep.python : undefined,
    }
  }

  return {
    id: skillId,
    name: fm.name as string,
    description,
    userDescription,
    whenToUse: typeof fm.when_to_use === 'string' ? fm.when_to_use : undefined,
    triggers: parseTriggers(fm.triggers),
    version,
    enabled,
    source,
    context,
    allowedTools,
    model: typeof fm.model === 'string' ? fm.model : undefined,
    agentType: typeof fm.agent_type === 'string' ? fm.agent_type : undefined,
    dependency,
    content: bodyContent,
    filePath,
    skillDir: skillDir || path.dirname(filePath),
    loadedAt: Date.now(),
  }
}

/** 获取默认技能目录 */
function getDefaultSkillsDir(): string {
    return path.join(getHclawDir(), 'skills')
}

/**
 * 解析 triggers 字段
 * 支持字符串或字符串数组格式
 * - 单行字符串: triggers: "文本1, 文本2"
 * - YAML 数组: triggers: ["文本1", "文本2"]
 * - YAML 列表块格式
 */
function parseTriggers(triggers: unknown): string[] | undefined {
  if (triggers === undefined || triggers === null) {
    return undefined
  }

  // 如果是数组，直接过滤并返回
  if (Array.isArray(triggers)) {
    const result = triggers
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map(t => t.trim())
    return result.length > 0 ? result : undefined
  }

  // 如果是字符串，按逗号或换行分割
  if (typeof triggers === 'string') {
    const trimmed = triggers.trim()
    if (!trimmed) {
      return undefined
    }

    // 检查是否是多行格式（包含换行符）
    if (trimmed.includes('\n')) {
      const result = trimmed
        .split(/\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0)
      return result.length > 0 ? result : undefined
    }

    // 单行逗号分隔格式
    const result = trimmed
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
    return result.length > 0 ? result : undefined
  }

  return undefined
}

// ─── skill_overrides 持久化（SQLite）───────────────────────────
// 用户通过 UI 切换技能的启用状态后，覆盖值写入 skill_overrides 表，
// 后续加载技能时从表中读取覆盖值，优先于文件中的 enabled 字段。

/** 从 SQLite 读取所有 skill_overrides */
export function readSkillOverridesSync(): Map<string, boolean> {
    try {
        const db = getDatabase()
        const rows = db.prepare('SELECT skill_id, enabled FROM skill_overrides').all() as Array<{
            skill_id: string
            enabled: number
        }>
        const map = new Map<string, boolean>()
        for (const row of rows) {
            map.set(row.skill_id, row.enabled === 1)
        }
        return map
    } catch {
        return new Map()
    }
}

/** 写入单个 skill 的覆盖状态 */
export function writeSkillOverride(skillId: string, enabled: boolean): void {
    try {
        const db = getDatabase()
        const now = Date.now()
        db.prepare('INSERT OR REPLACE INTO skill_overrides (skill_id, enabled, updated_at) VALUES (?, ?, ?)')
            .run(skillId, enabled ? 1 : 0, now)
    } catch (err) {
        logger.error('[SkillsLoader] writeSkillOverride failed', {skillId, error: (err as Error).message})
    }
}

/** 写入批量 skill 的覆盖状态 */
export function writeSkillOverrides(overrides: Array<{ skillId: string; enabled: boolean }>): void {
    try {
        const db = getDatabase()
        const now = Date.now()
        const stmt = db.prepare('INSERT OR REPLACE INTO skill_overrides (skill_id, enabled, updated_at) VALUES (?, ?, ?)')
        for (const {skillId, enabled} of overrides) {
            stmt.run(skillId, enabled ? 1 : 0, now)
        }
    } catch (err) {
        logger.error('[SkillsLoader] writeSkillOverrides batch failed', {error: (err as Error).message})
    }
}

/** 从 skillRegistry 中的所有技能应用 skill_overrides 覆盖 */
export function applySkillOverrides(): void {
    const overrides = readSkillOverridesSync()
    const disabledPlugins = PluginRegistry.getInstance().getDisabledNames()

    // 无覆盖且无禁用插件 → 无需遍历
    if (overrides.size === 0 && disabledPlugins.size === 0) return

    const allSkills = skillRegistry.getAll()
    let appliedCount = 0
    for (const skill of allSkills) {
        // 已禁用插件的技能强制 disabled，不允许覆盖重新启用
        if (skill.pluginName && disabledPlugins.has(skill.pluginName)) {
            skill.enabled = false
            continue
        }
        const overrideEnabled = overrides.get(skill.id)
        if (overrideEnabled !== undefined) {
            skill.enabled = overrideEnabled
            appliedCount++
        }
    }
    if (appliedCount > 0) {
        logger.debug('[SkillsLoader] applySkillOverrides: applied', {count: appliedCount})
    }
}
