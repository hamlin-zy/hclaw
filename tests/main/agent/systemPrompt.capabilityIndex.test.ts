import {describe, expect, it, vi} from 'vitest'

// 隔离保证：systemPrompt → config → repositories 存在循环依赖（_cachedHclawDir TDZ），
// mock 掉 config 切断链路。
vi.mock('../../../src/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))

import {buildSystemPrompt} from '../../../src/main/agent/systemPrompt'
import {skillRegistry} from '../../../src/main/agent/skills/registry'
import type {SkillDefinition} from '../../../src/main/agent/skills/types'

const ctx = {
  workingDir: '/x',
  tools: [],
  permissionMode: 'auto',
} as any

function makeSkill(id: string): SkillDefinition {
  return {
    id,
    name: id,
    description: `desc-${id}`,
    whenToUse: `trigger-${id}`,
    enabled: true,
    content: 'body',
  } as SkillDefinition
}

/** 去除含"当前日期"的行，避免时间戳影响字节比较 */
function stripDateLines(s: string): string {
  return s.split('\n').filter(l => !l.includes('当前日期')).join('\n')
}

describe('System Prompt 能力索引迁出 + routing 常驻', () => {
  it('system prompt 不含能力索引表', async () => {
    skillRegistry.register(makeSkill('demo-skill'))
    const p = await buildSystemPrompt(ctx)
    expect(p).not.toContain('## 可用能力')
    expect(p).not.toContain('| 名称 | 类型 | 描述 | 触发条件 |')
  })

  it('routing 段落恒定：注册/清空技能前后输出（去日期行）byte-equal', async () => {
    skillRegistry.clear()
    const p0 = await buildSystemPrompt(ctx)

    skillRegistry.register(makeSkill('demo-skill'))
    const p1 = await buildSystemPrompt(ctx)
    expect(stripDateLines(p1)).toBe(stripDateLines(p0))

    skillRegistry.clear()
  })
})
