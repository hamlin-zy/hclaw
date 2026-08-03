/**
 * agent 工具派遣引导 单元测试
 *
 * 背景：superpowers 的 implementer-prompt.md / task-reviewer-prompt.md 等模板使用
 * Claude Code 生态的 `Subagent (general-purpose)` 语法派发子代理。HClaw 中不存在
 * 该同名 Agent，LLM 照搬模板名会回退 General Agent。
 *
 * 方案：不在程序中硬编码模板名 → Agent 映射（角色应由 LLM 依据任务内容判断，
 * 静态映射无法区分同名模板且会耦合三方插件命名），改为在 agent 工具 description
 * 中向 LLM 说明该语法，引导其从可用能力列表选择专用 Agent。
 *
 * 本测试锁定该引导语不被误删/回退。专用 Agent 的可发现性由运行时 powerManager
 * 扫描流程注入系统提示，单测不覆盖。
 */
import {describe, expect, it} from 'vitest'
import {agentTool} from '@/main/agent/tools/builtin/agentTool'

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

    it('提示未知名会回退 General Agent', () => {
        expect(agentTool.description).toContain('General')
    })
})
