/**
 * AgentManager 插件 Agent 加载器
 */

import * as fs from 'fs'
import * as path from 'path'
import yaml from 'js-yaml'
import {PluginRegistry} from '../plugin/registry'
import {logger} from './logger'
import type {AgentTemplate} from '@shared/types'

/**
 * 从已启用的插件加载 Agent 模板
 *
 * 插件 Agent 目录结构：
 * ~/.hclaw/plugins/{pluginName}/agents/{agentName}.md
 *
 * Agent 定义格式（markdown）：
 * ---
 * name: agent-name
 * description: Agent 描述
 * type: plan|explore|verification|general
 * ---
 * # Agent 内容...
 */
export function loadPluginAgents(): AgentTemplate[] {
  const registry = PluginRegistry.getInstance()
  const enabledPlugins = registry.getEnabled()
  const templates: AgentTemplate[] = []

  for (const plugin of enabledPlugins) {
    const agentsDir = path.join(plugin.path, 'agents')
    if (!fs.existsSync(agentsDir)) continue

    try {
      const files = fs.readdirSync(agentsDir)
      const mdFiles = files.filter((f) => f.endsWith('.md') && !f.startsWith('readme'))

      for (const file of mdFiles) {
        const filePath = path.join(agentsDir, file)
        const agentName = path.basename(file, '.md')

        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          const parsed = parseMarkdownFrontmatter(content)
          if (!parsed) continue

          const raw = parsed.frontmatter
          const name = (raw.name as string) || agentName
          const description = (raw.description as string) || ''
          const agentType = raw.type as string | undefined
          const tags = Array.isArray(raw.tags)
            ? (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string')
            : agentType ? [agentType] : []

          templates.push({
            id: `${plugin.name}:${agentName}`,
            name,
            description,
            systemPrompt: parsed.bodyContent,
            enabled: true,
            tags,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        } catch (err) {
          logger.warn('[AgentManager] parseAgentFileFailed', {filePath, error: err})
        }
      }
    } catch (err) {
      logger.warn('[AgentManager] readPluginsDirFailed', {error: err})
    }
  }

  return templates
}

/**
 * 解析 Markdown 文件中的 YAML frontmatter
 */
export function parseMarkdownFrontmatter(content: string): {frontmatter: Record<string, unknown>; bodyContent: string} | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  try {
    const frontmatter = yaml.load(match[1]) as Record<string, unknown>
    const bodyContent = match[2].trim()
    return {frontmatter, bodyContent}
  } catch {
    return null
  }
}