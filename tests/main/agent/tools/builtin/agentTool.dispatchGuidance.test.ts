/**
 * agent 工具派遣引导 单元测试
 *
 * 背景：superpowers 的 implementer-prompt.md / task-reviewer-prompt.md 等模板使用
 * Claude Code 生态的 `Subagent (general-purpose)` 语法派发子代理。HClaw 中不存在
 * 该同名 Agent。
 *
 * 方案：agent 参数为必填，LLM 必须从可用 Agent 列表中选择（实现→Implementer、
 * 审查→Code Reviewer 等）；填写列表外名称（如 general-purpose 模板名）时工具
 * 返回错误 + 可用列表，强制 LLM 修正后重试，而非静默回退 General。
 *
 * 本测试锁定：
 * 1. 引导语（description）不被误删/回退；
 * 2. execute 行为级用例：未知名 agent → 返回错误 + 可用列表，且不触碰后续
 *    repository / agentLoop 依赖（在 agentRegistry.find 未命中后立即短路）。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// 必须在使用前 mock：agentTool 内部 import 了 runtimeConfigManager / agentRegistry。
// vi.hoisted：mock 工厂被提升到文件顶部，必须在工厂内构造可引用的 mock。
const mocks = vi.hoisted(() => ({
    getPrimaryProvider: vi.fn(),
    find: vi.fn(),
    getEnabled: vi.fn(),
}))

vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getPrimaryProvider: mocks.getPrimaryProvider,
        // agentTool 模块顶层 buildModelRoleSchema() 需要；测试仅涉 execute，方案为空即可
        getScheme: () => null,
        getProviders: () => [],
        getConfig: () => ({workingDir: ''}),
    },
}))

vi.mock('@/main/agent/agentRegistry', () => ({
    agentRegistry: {
        find: mocks.find,
        getEnabled: mocks.getEnabled,
    },
}))

import {agentTool} from '@/main/agent/tools/builtin/agentTool'

const CONTEXT = {conversationId: 'conv-test'} as any

beforeEach(() => {
    // 默认：主模型已配置 + 未找到该 agent
    mocks.getPrimaryProvider.mockReturnValue({isValid: true})
    mocks.find.mockReturnValue(undefined)
    mocks.getEnabled.mockReturnValue([])
})

describe('agent 工具派遣引导（superpowers 模板语法 → 专用 Agent）', () => {
    it('说明 superpowers 的 general-purpose 模板名在 HClaw 不存在', () => {
        expect(agentTool.description).toContain('general-purpose')
    })

    it('引导实现任务选择 Implementer Agent', () => {
        expect(agentTool.description).toContain('Implementer Agent')
    })

    it('引导审查任务选择 Code Reviewer Agent', () => {
        expect(agentTool.description).toContain('Code Reviewer Agent')
    })

    it('提示未知名会报错并要求重试（不再静默回退 General）', () => {
        expect(agentTool.description).toContain('报错并要求重试')
    })
})

describe('agent 工具 execute — 未知名 agent 的行为', () => {
    it('agent 不存在 → 返回 error（含"不存在"提示），不静默回退 General', async () => {
        mocks.find.mockReturnValue(undefined)

        const result = await agentTool.execute(
            {task: '实现一个功能', agent: 'Subagent (general-purpose)'},
            CONTEXT,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('不存在')
        expect(result.error).toContain('Subagent (general-purpose)')
    })

    it('错误信息包含可用 Agent 列表（非空时逐一名列）', async () => {
        mocks.getEnabled.mockReturnValue([
            {name: 'Implementer Agent'},
            {name: 'Code Reviewer Agent'},
            {name: 'Explore Agent'},
        ] as any)

        const result = await agentTool.execute(
            {task: '审查代码', agent: 'General-purpose'},
            CONTEXT,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('Implementer Agent')
        expect(result.error).toContain('Code Reviewer Agent')
        expect(result.error).toContain('Explore Agent')
    })

    it('可用列表为空时兜底提示 General Agent', async () => {
        const result = await agentTool.execute(
            {task: '写测试', agent: 'unknown-agent'},
            CONTEXT,
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('General Agent')
    })
})
