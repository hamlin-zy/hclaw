/**
 * SkillMatcher 单元测试
 *
 * 覆盖评分维度：名称完全匹配 / 名称分词 / 描述关键词 / 正文关键词 /
 * 复杂意图增强 / needsPlanning 增强 / 不匹配 / disabled 过滤 / topK 截断 /
 * 排序 / 中文关键词提取。
 *
 * 评分逻辑（与实现对齐）：
 * - 名称完全匹配 +10
 * - 名称分词 +3/词
 * - 描述关键词 +1.5/个
 * - 正文关键词 >2 个 → +0.3/个（上限 2）
 * - complexity === 'complex' 且 score > 5 → ×1.2
 * - needsPlanning 且 score > 3 → ×1.1
 */
import {describe, expect, it} from 'vitest'
import {SkillMatcher, skillMatcher} from '@/main/agent/skills/matcher'
import type {SkillDefinition} from '@/main/agent/skills/types'
import type {IntentAnalysisResult} from '@shared/types'

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 's1',
    name: '测试技能',
    description: 'desc',
    content: '',
    enabled: true,
    version: '1.0.0',
    loadedAt: 0,
    ...overrides,
  }
}

function makeIntent(overrides: Partial<IntentAnalysisResult> = {}): IntentAnalysisResult {
  return {
    summary: 'summary',
    complexity: 'moderate',
    estimatedSteps: 1,
    needsPlanning: false,
    suggestedModel: 'primary',
    ...overrides,
  }
}

describe('SkillMatcher.match — 名称匹配', () => {
  it('名称完全匹配 → score 含 +10，matchedKeywords 含技能名', () => {
    const skill = makeSkill({name: '测试技能'})
    const result = skillMatcher.match('测试技能', [skill])
    expect(result).toHaveLength(1)
    expect(result[0]!.score).toBeGreaterThanOrEqual(10)
    expect(result[0]!.matchedKeywords).toContain('测试技能')
  })

  it('名称分词匹配（name=pdf-处理，消息=处理 pdf）→ 命中分词 +3', () => {
    const skill = makeSkill({id: 'pdf', name: 'pdf-处理'})
    const result = skillMatcher.match('处理 pdf', [skill])
    expect(result).toHaveLength(1)
    expect(result[0]!.matchedKeywords).toContain('处理')
    expect(result[0]!.matchedKeywords).toContain('pdf')
    expect(result[0]!.score).toBeGreaterThanOrEqual(6)
  })
})

describe('SkillMatcher.match — 描述与正文匹配', () => {
  it('描述关键词匹配 → 命中 desc 关键词', () => {
    const skill = makeSkill({description: '分析图片内容'})
    // 实现按整词匹配：消息词 '分析图片' 包含于 description
    const result = skillMatcher.match('分析图片', [skill])
    expect(result).toHaveLength(1)
    expect(result[0]!.score).toBeGreaterThanOrEqual(1.5)
    expect(result[0]!.reason).toContain('描述匹配')
  })

  it('正文匹配：content 含多个关键词 → 触发 contentMatches > 2', () => {
    const skill = makeSkill({
      content: '本技能用于处理 markdown 文档，支持表格、图片引用、代码块和模板生成',
    })
    const result = skillMatcher.match('markdown 表格 图片引用 代码块 模板', [skill])
    expect(result).toHaveLength(1)
    expect(result[0]!.reason).toContain('内容匹配')
  })
})

describe('SkillMatcher.match — 意图增强', () => {
  it('complex 意图 + score>5 → ×1.2', () => {
    const skill = makeSkill({name: '测试技能'})
    const base = skillMatcher.match('测试技能', [skill])[0]!.score
    expect(base).toBeGreaterThan(5)
    const enhanced = skillMatcher.match('测试技能', [skill], makeIntent({complexity: 'complex'}))[0]!.score
    expect(enhanced).toBeCloseTo(base * 1.2, 5)
  })

  it('needsPlanning 意图 + score>3 → ×1.1', () => {
    const skill = makeSkill({name: '测试技能'})
    const base = skillMatcher.match('测试技能', [skill])[0]!.score
    expect(base).toBeGreaterThan(3)
    const enhanced = skillMatcher.match('测试技能', [skill], makeIntent({needsPlanning: true}))[0]!.score
    expect(enhanced).toBeCloseTo(base * 1.1, 5)
  })

  it('complex 与 needsPlanning 同时成立 → 依次叠加', () => {
    const skill = makeSkill({name: '测试技能'})
    const base = skillMatcher.match('测试技能', [skill])[0]!.score
    const enhanced = skillMatcher.match(
      '测试技能',
      [skill],
      makeIntent({complexity: 'complex', needsPlanning: true}),
    )[0]!.score
    expect(enhanced).toBeCloseTo(base * 1.2 * 1.1, 5)
  })
})

describe('SkillMatcher.match — 过滤与排序', () => {
  it('不匹配（score=0）→ 结果为空', () => {
    const skill = makeSkill({name: '不相关的技能'})
    expect(skillMatcher.match('完全不相关的内容', [skill])).toHaveLength(0)
  })

  it('disabled 技能不参与匹配', () => {
    const disabled = makeSkill({name: '测试技能', enabled: false})
    expect(skillMatcher.match('测试技能', [disabled])).toHaveLength(0)
  })

  it('topK 截断：5 个技能匹配，topK=2 → 返回 2 个', () => {
    const skills = Array.from({length: 5}, (_, i) =>
      makeSkill({id: `s${i}`, name: `测试技能-${i}`}),
    )
    const result = skillMatcher.match('测试技能', skills, undefined, 2)
    expect(result).toHaveLength(2)
  })

  it('排序：高分在前（名称匹配 > 描述匹配 > 正文匹配）', () => {
    const nameMatch = makeSkill({id: 'name', name: '测试技能'})
    const descMatch = makeSkill({id: 'desc', name: '其他技能', description: '测试技能 描述'})
    const weakMatch = makeSkill({id: 'weak', name: '弱相关技能', description: '无关描述'})
    const result = skillMatcher.match('测试技能 描述', [weakMatch, descMatch, nameMatch])
    expect(result.map(m => m.skill.id)).toEqual(['name', 'desc', 'weak'])
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score)
    }
  })

  it('中文关键词提取：保留中文，正确命中', () => {
    const skill = makeSkill({name: '数据分析'})
    const result = skillMatcher.match('请，帮我：数据分析！', [skill])
    expect(result).toHaveLength(1)
    expect(result[0]!.matchedKeywords).toContain('数据分析')
  })
})

describe('SkillMatcher 实例', () => {
  it('单例导出可调用 match', () => {
    const skill = makeSkill({name: '测试技能'})
    expect(skillMatcher).toBeInstanceOf(SkillMatcher)
    expect(skillMatcher.match('测试技能', [skill])).toHaveLength(1)
  })
})
