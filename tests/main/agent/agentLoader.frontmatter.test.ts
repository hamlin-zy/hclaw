/**
 * agentLoader.parseMarkdownFrontmatter 单元测试
 *
 * 覆盖：
 * - 标准 frontmatter 正常解析
 * - 未加引号的 `: `（冒号+空格）纯量值回退修复（如 description 含 "great DX: intuitive"）
 * - 已加引号 / 流式集合 / 块标量的 `: ` 不被误修
 * - 无 frontmatter / 无法修复时返回 null
 */
import {describe, expect, it} from 'vitest'
import {parseMarkdownFrontmatter, repairUnquotedColonValues} from '@/main/agent/utils/agentFrontmatter'

describe('parseMarkdownFrontmatter — 标准 frontmatter', () => {
  it('标准 frontmatter 正常解析并返回正文', () => {
    const content = [
      '---',
      'name: My Agent',
      'description: A normal description',
      'tools: [file_read, file_write]',
      '---',
      '',
      '# My Agent',
      '',
      'System prompt body',
    ].join('\n')

    const result = parseMarkdownFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.frontmatter.name).toBe('My Agent')
    expect(result!.frontmatter.description).toBe('A normal description')
    expect(result!.frontmatter.tools).toEqual(['file_read', 'file_write'])
    expect(result!.bodyContent).toContain('System prompt body')
  })
})

describe('parseMarkdownFrontmatter — 容错修复', () => {
  it('未加引号的 ": " 纯量值可成功解析（回归：engineering-developer-tooling-engineer）', () => {
    const content = [
      '---',
      'name: Developer Tooling Engineer',
      'description: building great DX: intuitive command design, helpful errors',
      'color: "#4F46E5"',
      'emoji: 🛠️',
      '---',
      '',
      'System prompt body',
    ].join('\n')

    const result = parseMarkdownFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.frontmatter.name).toBe('Developer Tooling Engineer')
    expect(result!.frontmatter.description).toBe(
      'building great DX: intuitive command design, helpful errors',
    )
    expect(result!.frontmatter.color).toBe('#4F46E5')
    expect(result!.frontmatter.emoji).toBe('🛠️')
  })
})

describe('repairUnquotedColonValues — 不误改其他 YAML 结构', () => {
  it('已加引号的值不改动', () => {
    const input = 'description: "already: quoted"\n'
    expect(repairUnquotedColonValues(input)).toBe(input)
  })

  it('流式集合/块标量不改动', () => {
    const input = 'tools: [a: 1, b: 2]\nbody: |\n  line one: x\n'
    expect(repairUnquotedColonValues(input)).toBe(input)
  })

  it('含 ": " 的纯量值被加引号', () => {
    expect(repairUnquotedColonValues('description: foo: bar\n')).toBe(
      'description: "foo: bar"\n',
    )
  })
})

describe('parseMarkdownFrontmatter — 失败路径', () => {
  it('无 frontmatter 返回 null', () => {
    expect(parseMarkdownFrontmatter('just plain text\n\nbody')).toBeNull()
  })

  it('无法修复的 YAML 返回 null', () => {
    // 故意构造无法通过修复解决的非法 YAML（如缩进异常的嵌套映射）
    const content = ['---', 'a: 1', '  - 2', '  bad: 3', '---', 'body'].join('\n')
    expect(parseMarkdownFrontmatter(content)).toBeNull()
  })
})
