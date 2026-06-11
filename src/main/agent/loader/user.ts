/**
 * User Agent 加载器
 * 从 ~/.hclaw/agents/ 加载用户自定义 Agent
 */

import * as fs from 'fs'
import * as path from 'path'
import yaml from 'js-yaml'
import type {AgentIsolationMode, AgentPermissionMode, UserAgentDefinition} from '@shared/agent'
import {getHclawDir} from '../../config'
import {renderSystemPrompt} from '../prompts/renderer'
import {getAgentField, getStringField} from '../../utils/fieldMapper'

const AGENTS_DIR = path.join(getHclawDir(), 'agents')
const SUPPORTED_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml'])

/**
 * 解析工具字段
 */
function parseToolsField(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (value === '*') return undefined

  if (typeof value === 'string') {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }

  return undefined
}

/**
 * 解析 tags 字段
 */
function parseTagsField(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter['tags']

  if (Array.isArray(tags)) {
    return tags.filter((t): t is string => typeof t === 'string')
  }

  if (typeof tags === 'string') {
    return [tags]
  }

  const category = frontmatter['category']
  if (typeof category === 'string') {
    return [category]
  }

  return []
}

/**
 * 解析 Markdown 文件中的 YAML frontmatter
 * 支持多种字段命名风格：systemPrompt/system_prompt, userDescription/user_description 等
 */
function parseMarkdownAgent(content: string, filePath: string): UserAgentDefinition | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  try {
    const frontmatter = (yaml as any).load(match[1]) as Record<string, unknown>
    const bodyContent = match[2].trim()

      const agentType = getAgentField<string>(frontmatter, 'name')
      const description = getAgentField<string>(frontmatter, 'description')

    if (!agentType || !description) {
      return null
    }

      // 使用字段映射工具获取 systemPromptTemplate（支持多种命名）
    const systemPromptTemplate = bodyContent ||
        getStringField(frontmatter, 'systemPromptTemplate', ['systemPrompt', 'prompt'])

      // 使用字段映射获取其他字段
      const longDescription = getAgentField<string>(frontmatter, 'userDescription')
      const tools = parseToolsField(getAgentField(frontmatter, 'allowedTools'))
      const disallowedTools = parseToolsField(getAgentField(frontmatter, 'disallowedTools'))
      const permissionMode = getAgentField<AgentPermissionMode>(frontmatter, 'permissionMode')
      const maxTurns = getAgentField<number>(frontmatter, 'maxTurns')
      const isolation = getAgentField<AgentIsolationMode>(frontmatter, 'isolation')
      const background = getAgentField<boolean>(frontmatter, 'background')

      // whenToUse: 新格式显式指定，旧文件回退到 description
      const whenToUse = getAgentField<string>(frontmatter, 'whenToUse') || description

    return {
      source: 'user',
      agentType,
      whenToUse,
        description: longDescription || description,
      systemPromptTemplate,
      renderedSystemPrompt: '',
        tools,
        disallowedTools,
      tags: parseTagsField(frontmatter),
        color: getAgentField<string>(frontmatter, 'color'),
        model: getAgentField<string>(frontmatter, 'model'),
        permissionMode,
        maxTurns,
        isolation,
        background,
      filename: path.basename(filePath, path.extname(filePath)),
    }
  } catch {
    return null
  }
}

/**
 * 从 JSON/YAML 对象解析 Agent
 * 支持多种字段命名风格
 */
function parseJsonAgent(raw: Record<string, unknown>, filePath: string): UserAgentDefinition | null {
    const agentType = getAgentField<string>(raw, 'name')
    const description = getAgentField<string>(raw, 'description')

  if (!agentType || !description) return null

    // 使用字段映射工具获取系统提示词（支持多种命名）
    const systemPrompt = getStringField(raw, 'systemPromptTemplate', ['systemPrompt', 'prompt'])

    // 使用字段映射获取其他字段
    const longDescription = getAgentField<string>(raw, 'userDescription')
    const tools = parseToolsField(getAgentField(raw, 'allowedTools'))
    const disallowedTools = parseToolsField(getAgentField(raw, 'disallowedTools'))
    const permissionMode = getAgentField<AgentPermissionMode>(raw, 'permissionMode')
    const maxTurns = getAgentField<number>(raw, 'maxTurns')
    const isolation = getAgentField<AgentIsolationMode>(raw, 'isolation')
    const background = getAgentField<boolean>(raw, 'background')

    // whenToUse: 新格式显式指定，旧文件回退到 description
    const whenToUse = getAgentField<string>(raw, 'whenToUse') || description

  return {
    source: 'user',
    agentType,
    whenToUse,
      description: longDescription || description,
    systemPromptTemplate: systemPrompt,
    renderedSystemPrompt: '',
      tools,
      disallowedTools,
    tags: parseTagsField(raw),
      color: getAgentField<string>(raw, 'color'),
      model: getAgentField<string>(raw, 'model'),
      permissionMode,
      maxTurns,
      isolation,
      background,
    filename: path.basename(filePath, path.extname(filePath)),
  }
}

/**
 * 递归扫描 agents 目录
 */
function walkDir(dir: string): string[] {
  const results: string[] = []

  function walk(currentDir: string): void {
    if (!fs.existsSync(currentDir)) return

    const entries = fs.readdirSync(currentDir, {withFileTypes: true})

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name))
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(path.join(currentDir, entry.name))
      }
    }
  }

  walk(dir)
  return results
}

/**
 * 加载所有 User Agents
 */
export async function loadUserAgents(): Promise<{
  agents: UserAgentDefinition[]
  failedFiles: Array<{ path: string; error: string }>
}> {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, {recursive: true})
    return { agents: [], failedFiles: [] }
  }

  const files = walkDir(AGENTS_DIR)
  const agents: UserAgentDefinition[] = []
  const failedFiles: Array<{ path: string; error: string }> = []

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const ext = path.extname(filePath).toLowerCase()

      let agent: UserAgentDefinition | null = null
      if (ext === '.md') {
        agent = parseMarkdownAgent(content, filePath)
      } else if (ext === '.json') {
        const raw = JSON.parse(content)
        agent = parseJsonAgent(raw, filePath)
      } else if (ext === '.yaml' || ext === '.yml') {
        const raw = (yaml as any).load(content) as Record<string, unknown>
        agent = parseJsonAgent(raw, filePath)
      }

      if (agent) {
        // 渲染系统提示词（使用默认值）
        agent.renderedSystemPrompt = renderSystemPrompt(agent.systemPromptTemplate, {
          availableTools: [],
          permissionMode: 'auto',
          workingDir: process.cwd(),
        })
        agents.push(agent)
      }
    } catch (err: any) {
      failedFiles.push({ path: filePath, error: err.message })
    }
  }

  return { agents, failedFiles }
}
