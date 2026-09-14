/**
 * 命令加载器
 *
 * 从 ~/.hclaw/commands/ 目录扫描并解析命令定义文件（.md），
 * 然后从 command_overrides 表覆盖 enabled 状态。
 *
 * 与 agentLoader.ts 的设计模式一致：文件系统 + DB overrides。
 */

import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import yaml from 'js-yaml'
import {getHclawDir} from '../config'
import type {CommandDefinition} from '@shared/types'
import {logger} from './logger'
import {createSqliteOwnershipDeps, resolve} from '../common/pluginOwnership'

// ─── 常量 ────────────────────────────────────────────────

const COMMANDS_DIR = path.join(getHclawDir(), 'commands')
const SUPPORTED_EXTENSIONS = new Set(['.md'])

// ─── 类型 ────────────────────────────────────────────────

// ─── 解析函数 ─────────────────────────────────────────────

/**
 * 解析 YAML frontmatter + body 的 Markdown
 * 格式:
 * ---
 * name: command-name
 * description: ...
 * enabled: true
 * args:
 *   - name: code
 *     description: ...
 *     required: true
 * ---
 * Command content here...
 */
function parseCommandMarkdown(content: string): {
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
    logger.debug('[CommandLoader] failed to parse YAML frontmatter', {error: err})
    return null
  }
}

/**
 * 从解析结果构建 CommandDefinition
 */
function buildCommandDefinition(
  id: string,
  raw: Record<string, unknown>,
  bodyContent: string,
  filePath: string,
): CommandDefinition {
  const name = (raw.name as string) || path.basename(filePath, '.md')
  const description = (raw.description as string) || ''
  const enabled = raw.enabled !== false // 默认为 true
  const rawArgs = raw.args

  let args: CommandDefinition['args'] = undefined
  if (Array.isArray(rawArgs)) {
    args = rawArgs.map((a: any) => ({
      name: String(a.name || ''),
      description: a.description ? String(a.description) : undefined,
      required: a.required === true ? true : undefined,
      default: a.default !== undefined ? String(a.default) : undefined,
    }))
  }

  const now = Date.now()
  return {
    id,
    name,
    description,
    enabled,
    content: bodyContent,
    args,
    filePath,
    createdAt: now,
    updatedAt: now,
  }
}

// ─── 扫描函数 ─────────────────────────────────────────────

/**
 * 扫描命令目录，收集所有 .md 文件
 */
async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = []

  try {
    await fsPromises.access(dir)
  } catch {
    return results
  }

  const entries = await fsPromises.readdir(dir, {withFileTypes: true})

  for (const entry of entries) {
    if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(path.join(dir, entry.name))
    }
  }

  return results
}

/**
 * 从单个目录扫描并解析所有命令文件
 */
async function scanCommandDirectory(dir: string): Promise<CommandDefinition[]> {
  const commands: CommandDefinition[] = []

  try {
    const files = await walkDir(dir)

    for (const filePath of files) {
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8')

        // 快速检查是否包含 frontmatter
        if (!content.startsWith('---')) {
          continue
        }

        const parsed = parseCommandMarkdown(content)
        if (!parsed) {
          logger.debug('[CommandLoader] failed to parse command file', {filePath})
          continue
        }

        const id = path.basename(filePath, '.md')
        commands.push(buildCommandDefinition(id, parsed.frontmatter, parsed.bodyContent, filePath))
      } catch (err) {
        logger.debug('[CommandLoader] failed to read file', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err) {
    logger.debug('[CommandLoader] failed to scan directory', {
      dir,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return commands
}

// ─── 公开接口 ─────────────────────────────────────────────

/**
 * 加载所有命令
 * 流程：扫描文件 → 解析 frontmatter → 构建 CommandDefinition → DB override 覆盖 enabled
 */
export async function loadCommands(): Promise<CommandDefinition[]> {
  logger.debug('[CommandLoader] loadCommands: starting...')

  // 确保目录存在
  if (!fs.existsSync(COMMANDS_DIR)) {
    fs.mkdirSync(COMMANDS_DIR, {recursive: true})
    logger.debug('[CommandLoader] created commands directory', {dir: COMMANDS_DIR})
    return []
  }

  // 扫描目录
  const allCommands = await scanCommandDirectory(COMMANDS_DIR)

  // 应用启用态：插件禁用 > command_overrides 表值 > 文件默认
  // （文件命令无插件归属，pluginName 传 null；统一由 pluginOwnership 判定）
  const deps = createSqliteOwnershipDeps()
  let appliedCount = 0
  for (const cmd of allCommands) {
    const {capabilityEnabled} = resolve(
      {kind: 'command', id: cmd.id, pluginName: null, fileEnabled: cmd.enabled},
      deps,
    )
    if (capabilityEnabled !== cmd.enabled) {
      cmd.enabled = capabilityEnabled
      appliedCount++
    }
  }

  if (appliedCount > 0) {
    logger.debug('[CommandLoader] loadCommands: applied overrides', {count: appliedCount})
  }

  logger.debug('[CommandLoader] loadCommands: total', {count: allCommands.length})

  return allCommands
}

/**
 * 获取命令目录路径
 */
export function getCommandsDir(): string {
  return COMMANDS_DIR
}
