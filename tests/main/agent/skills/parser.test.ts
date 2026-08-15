/**
 * parseSkillMarkdown 单元测试
 *
 * 覆盖 frontmatter 完整解析、缺失 name 抛错、默认值、enabled=false、
 * markdownContent 剥离、纯 markdown（无 frontmatter）行为。
 *
 * 注意：gray-matter 的 YAML 默认解析中 `version: 1.0.0` 会解析为字符串 '1.0.0'；
 * 若写成 `version: 1.0` 会被解析为数字 1 → String(...) 得 '1'。
 */
import {describe, expect, it} from 'vitest'
import {parseSkillMarkdown} from '@/main/agent/skills/parser'

const FILE_PATH = '/tmp/skills/custom/skill/SKILL.md'

describe('parseSkillMarkdown — 完整 frontmatter', () => {
  it('完整 frontmatter：name/description/user_description/version/enabled/context/model/allowed_tools/paths', () => {
    const content = [
      '---',
      'name: 图片分析',
      'description: 分析图片内容并提取信息',
      'user_description: 帮用户分析图片',
      'version: 2.1.0',
      'enabled: true',
      'context: inline',
      'model: sonnet',
      'allowed_tools: [file_read, file_write]',
      'paths: [src/**, "tests/**/*.spec.ts"]',
      '---',
      '',
      '# 图片分析',
      '',
      '技能正文内容',
    ].join('\n')

    const result = parseSkillMarkdown(content, FILE_PATH)
    expect(result.frontmatter.name).toBe('图片分析')
    expect(result.frontmatter.description).toBe('分析图片内容并提取信息')
    expect(result.frontmatter.user_description).toBe('帮用户分析图片')
    expect(result.frontmatter.version).toBe('2.1.0')
    expect(result.frontmatter.enabled).toBe(true)
    expect(result.frontmatter.context).toBe('inline')
    expect(result.frontmatter.model).toBe('sonnet')
    expect(result.frontmatter.allowed_tools).toEqual(['file_read', 'file_write'])
    expect(result.frontmatter.paths).toEqual(['src/**', 'tests/**/*.spec.ts'])
  })

  it('frontmatter 缺失字段 → 空串 / undefined 兜底', () => {
    const content = ['---', 'name: 仅名称', '---', '正文'].join('\n')
    const result = parseSkillMarkdown(content, FILE_PATH)
    expect(result.frontmatter.name).toBe('仅名称')
    expect(result.frontmatter.description).toBe('')
    expect(result.frontmatter.user_description).toBeUndefined()
    expect(result.frontmatter.context).toBeUndefined()
    expect(result.frontmatter.allowed_tools).toBeUndefined()
  })
})

describe('parseSkillMarkdown — 缺失 name', () => {
  it('缺失 name → 抛错，message 含 filePath', () => {
    const content = ['---', 'description: 没有名字', '---', '正文'].join('\n')
    expect(() => parseSkillMarkdown(content, FILE_PATH)).toThrowError(/name/)
    expect(() => parseSkillMarkdown(content, FILE_PATH)).toThrowError(FILE_PATH)
  })

  it('name 为空字符串 → 抛错', () => {
    const content = ['---', 'name: ""', '---', '正文'].join('\n')
    expect(() => parseSkillMarkdown(content, FILE_PATH)).toThrowError(FILE_PATH)
  })
})

describe('parseSkillMarkdown — 默认值', () => {
  it('无 enabled → true；无 version → 1.0.0', () => {
    const content = ['---', 'name: 默认技能', '---', '正文'].join('\n')
    const result = parseSkillMarkdown(content, FILE_PATH)
    expect(result.frontmatter.enabled).toBe(true)
    expect(result.frontmatter.version).toBe('1.0.0')
  })

  it('enabled: false → false', () => {
    const content = ['---', 'name: 禁用技能', 'enabled: false', '---', '正文'].join('\n')
    const result = parseSkillMarkdown(content, FILE_PATH)
    expect(result.frontmatter.enabled).toBe(false)
  })
})

describe('parseSkillMarkdown — markdownContent 剥离', () => {
  it('正确剥离 frontmatter，保留正文', () => {
    const content = [
      '---',
      'name: 剥离测试',
      '---',
      '# 标题',
      '',
      '第一段正文',
      '',
      '第二段正文',
    ].join('\n')
    const result = parseSkillMarkdown(content, FILE_PATH)
    expect(result.markdownContent).toContain('# 标题')
    expect(result.markdownContent).toContain('第一段正文')
    expect(result.markdownContent).toContain('第二段正文')
    expect(result.markdownContent).not.toContain('name:')
    expect(result.frontmatter.name).toBe('剥离测试')
  })
})

describe('parseSkillMarkdown — 无 frontmatter', () => {
  it('纯 markdown（无 frontmatter）→ name 为空抛错', () => {
    const content = '# 纯 Markdown\n\n没有 frontmatter'
    expect(() => parseSkillMarkdown(content, FILE_PATH)).toThrowError(FILE_PATH)
  })
})
