/**
 * 技能 Frontmatter 解析器
 */

import matter from 'gray-matter'
import type { SkillFrontmatter } from '@shared/skillTypes'

export function parseSkillMarkdown(
  content: string,
  filePath: string
): {
  frontmatter: SkillFrontmatter
  markdownContent: string
} {
  const parsed = matter(content)

  const frontmatter: SkillFrontmatter = {
    name: String(parsed.data.name || ''),
    description: String(parsed.data.description || ''),
    user_description: parsed.data.user_description as string | undefined,
    version: String(parsed.data.version || '1.0.0'),
    enabled: parsed.data.enabled === undefined ? true : Boolean(parsed.data.enabled),
    context: parsed.data.context as 'inline' | 'fork' | undefined,
    model: parsed.data.model as string | undefined,
    allowed_tools: parsed.data.allowed_tools as string[] | undefined,
    paths: parsed.data.paths as string[] | undefined,
    license: parsed.data.license as string | undefined,
    category: parsed.data.category as string | undefined,
    metadata: parsed.data.metadata as Record<string, unknown> | undefined,
  }

  if (!frontmatter.name) {
    throw new Error(`Missing 'name' in frontmatter: ${filePath}`)
  }

  return {
    frontmatter,
    markdownContent: parsed.content,
  }
}
