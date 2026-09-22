/**
 * entityCommandResolver — resolveSkillCommand（仅技能）单元测试
 *
 * 验证 capability「只解析技能」语义：
 * - 命中已启用技能 → 返回规范名 name + commandId `skill:<id>`
 * - agent 名 → null（不查 agent 注册表）
 * - 未知 / 未启用技能 → null
 *
 * skillRegistry / agentRegistry 均为纯内存注册表，用 register/clear 造数据与复位。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// entityCommandResolver → skills loader → config / sqlite 为纯副作用依赖
// （真实 sqlite 模块顶层 import getHclawDir，测试环境触发 TDZ "_cachedHclawDir"）；
// 本用例只测注册表解析，mock 掉即可（与 skills/loader.test.ts 同策略）。
vi.mock('@/main/config', () => ({getHclawDir: () => '/tmp/hclaw-test'}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw
vi.mock('@/main/repositories/sqlite', () => ({getDatabase: () => ({})}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({systemSettingsRepo: {}}))

import {resolveSkillCommand} from '@/main/agent/entityCommandResolver'
import {skillRegistry} from '@/main/agent/skills/registry'
import {agentRegistry} from '@/main/agent/agentRegistry'
import type {SkillDefinition} from '@/main/agent/skills/types'
import type {AgentTemplate} from '@shared/types'

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
    return {
        id: 'skill-default',
        name: '默认技能',
        description: '默认描述',
        enabled: true,
        content: '技能正文',
        loadedAt: 0,
        ...overrides,
    }
}

function makeAgent(overrides: Partial<AgentTemplate>): AgentTemplate {
    return {
        id: 'agent-default',
        name: '默认 Agent',
        description: '默认描述',
        systemPrompt: 'system prompt',
        enabled: true,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

describe('resolveSkillCommand — 仅解析技能', () => {
    beforeEach(() => {
        skillRegistry.clear()
        agentRegistry.clear()
    })
    afterEach(() => {
        skillRegistry.clear()
        agentRegistry.clear()
    })

    it('已知技能名 → commandId 以 skill: 开头，name 为技能规范名', () => {
        skillRegistry.register(makeSkill({id: 'brainstorming', name: 'Brainstorming'}))

        const result = resolveSkillCommand('brainstorming')
        expect(result).not.toBeNull()
        expect(result!.commandId).toBe('skill:brainstorming')
        expect(result!.name).toBe('Brainstorming')
        expect(result!.template).toContain('# 技能模式: Brainstorming')
    })

    it('模板携带「已加载」否定句（能力目录 delegation rules 追加于 CT 之后，否则模型重复调用 skill）', () => {
        skillRegistry.register(makeSkill({id: 'brainstorming', name: 'Brainstorming'}))

        const result = resolveSkillCommand('brainstorming')
        expect(result!.template).toContain('视为已加载完成')
        expect(result!.template).toContain('不要再用 skill / describe_skills 工具重复加载')
    })

    it('用别名（id）查询仍返回规范名（保证 /name 前缀可被 detectCommandContext 解析）', () => {
        skillRegistry.register(makeSkill({id: 'code-review', name: '代码审查'}))

        const result = resolveSkillCommand('code-review')
        expect(result!.name).toBe('代码审查')
    })

    it('agent 名 → null（不查 agent 注册表）', () => {
        agentRegistry.register(makeAgent({id: 'explore', name: 'Explore Agent'}))

        expect(resolveSkillCommand('Explore Agent')).toBeNull()
        expect(resolveSkillCommand('explore')).toBeNull()
    })

    it('未知技能名 → null', () => {
        expect(resolveSkillCommand('no-such-skill')).toBeNull()
    })

    it('技能存在但 enabled=false → null', () => {
        skillRegistry.register(makeSkill({id: 'off', name: 'Disabled Skill', enabled: false}))

        expect(resolveSkillCommand('Disabled Skill')).toBeNull()
    })
})
