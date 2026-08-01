/**
 * skillTool 单元测试
 *
 * 覆盖本次修复（方案 B）：
 * - output 携带完整指导（buildGuidance），而非 500 字截断预览
 * - injectMessage 保留完整指导（双保险，配合方案 A 的 adapter 修复）
 * - 回归：找不到技能 / 禁用技能的错误分支
 *
 * 注意：mock 掉 skills 模块（其真实依赖链会拉起 sqlite repository，
 * 在测试环境下触发 config.ts 的 TDZ 初始化问题——既有依赖问题，与本修复无关）。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// 必须先 mock，再 import skillTool（其内部 import 了 skills 模块）
// vi.hoisted：mock 工厂被提升到文件顶部，必须用 hoisted 才能在工厂内引用
const {mockRegistry} = vi.hoisted(() => ({
    mockRegistry: {
        register: vi.fn(),
        unregister: vi.fn(),
        unregisterByPlugin: vi.fn(),
        getAll: vi.fn(),
        get: vi.fn(),
        getConditionalSkills: vi.fn(() => []),
        find: vi.fn(),
        findConditionalSkills: vi.fn(() => []),
        getEnabled: vi.fn(() => []),
        syncPluginStatus: vi.fn(),
        clear: vi.fn(),
        getEnabledSkillContents: vi.fn(() => []),
    },
}))

vi.mock('@/main/agent/skills', () => ({
    skillRegistry: mockRegistry,
    skillActivator: {setConditionalSkills: vi.fn(), activateForPaths: vi.fn()},
}))

import {skillTool} from '@/main/agent/tools/builtin/skillTool'

const LONG_GUIDANCE =
    '## Overview\n\n' +
    '第一条指导内容，用于验证完整输出。\n'.repeat(50) +  // 远超 500 字
    '## 结尾标记\n\nEND_OF_GUIDANCE'

function registerTestSkill(id: string, name: string, enabled = true): void {
    mockRegistry.getAll.mockReturnValue([
        {
            id,
            name,
            description: `测试技能 ${name}`,
            enabled,
            source: 'test',
            content: LONG_GUIDANCE,
            filePath: `/fake/path/${name}/SKILL.md`,
            skillDir: `/fake/path/${name}`,
            loadedAt: Date.now(),
        },
    ])
    mockRegistry.find.mockImplementation((q: string) =>
        mockRegistry.getAll().find((s: any) => s.name === q || s.id === q),
    )
}

beforeEach(() => {
    mockRegistry.getAll.mockReturnValue([])
    mockRegistry.find.mockReturnValue(undefined)
})

describe('skillTool — output 携带完整指导（方案 B 修复）', () => {
    it('output 是完整 guidance，包含结尾内容，不含截断标记', async () => {
        registerTestSkill('test:writing-plans', 'writing-plans')

        const result = await skillTool.execute(
            {skill: 'writing-plans'},
            {} as any,
        )

        expect(result.success).toBe(true)
        // skillTool.execute 的 output 就是完整 guidance 文本（方案 B：非 500 字预览）
        const output = result.output as unknown as string
        // 完整内容到达
        expect(output).toContain('## Overview')
        expect(output).toContain('END_OF_GUIDANCE')
        // 不再有 500 字截断标记
        expect(output).not.toContain('...')
        // 开头是技能名标题（buildGuidance 格式）
        expect(output.startsWith('# writing-plans')).toBe(true)
    })

    it('injectMessage 携带完整指导（双保险，供 adapter 的 system 通道送达）', async () => {
        registerTestSkill('test:writing-plans', 'writing-plans')

        const result = await skillTool.execute(
            {skill: 'writing-plans'},
            {} as any,
        )

        const injected = (result as any).injectMessage as {role: string; content: string}
        expect(injected.role).toBe('system')
        expect(injected.content).toContain('END_OF_GUIDANCE')
        expect(injected.content).toContain('## 技能指导')
    })
})

describe('skillTool — 回归行为', () => {
    it('找不到技能返回错误', async () => {
        const result = await skillTool.execute(
            {skill: 'no-such-skill'},
            {} as any,
        )

        expect(result.success).toBe(false)
        const output = result.output as any
        expect(output.success).toBe(false)
        expect(output.error).toContain('未找到技能')
    })

    it('已禁用技能返回错误', async () => {
        registerTestSkill('test:disabled', 'disabled', false)

        const result = await skillTool.execute(
            {skill: 'disabled'},
            {} as any,
        )

        expect(result.success).toBe(false)
        const output = result.output as any
        expect(output.success).toBe(false)
        expect(output.error).toContain('技能已禁用')
    })
})
