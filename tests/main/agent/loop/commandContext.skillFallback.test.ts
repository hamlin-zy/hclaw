/**
 * detectCommandContext — metadata.commandId 技能兜底（结构性修复）
 *
 * 背景：能力经输入框徽标选择时，用户消息正文不带 `/` 前缀，只有落库 metadata 里带
 * `commandId`（如 `skill:systematic-debugging`）。原实现只认正文 `/name` 前缀 →
 * commandContext 恒为 null → controller 的 CT 注入分支不进 → 技能指导正文从未进入上下文。
 *
 * 锁定回退契约的是 C1（正文不以 / 开头且 metadata.commandId 为 `skill:<可解析名>` → 命中技能模板；
 * 其判别力由第一轮红灯实证：修复前该用例失败）。
 * C4 覆盖「无 commandId 且正文 `/` 前缀 → 走正文解析」这一既有行为。
 *
 * Round 3（W1）新增 N1~N4，锁定「命令来源权威化」契约：metadata.commandId 为 `skill:` / `agent:`
 * 前缀时以 metadata 为准、正文不参与解析（判断在 parseCommandText 之前）——修复显示名含空格
 * 的 agent（如 `/General Agent`）被 `\S+` 截断后误命中同名技能。
 * N1/N2 判别力由修复前版本（git show HEAD:src/main/agent/loop/setup.ts）红灯实证。
 * N3/N4 固化相邻行为（plugin: 前缀与无 commandId 仍走正文解析）。
 * C2/C3/C5/C6 为边界 / 防误伤用例，用于固化相邻行为，不承担「锁回归」职责：
 * - 无 commandId → null
 * - 其它前缀（agent: / plugin: / user）→ null（不得与既有 agent 分支双重注入）
 * - 已注册但 enabled=false 的技能 → null（不得注入被禁用的技能）
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// 依赖链桩：与 entityCommandResolver.test.ts 同策略（避免真实 ~/.hclaw 与 sqlite 顶层副作用）
vi.mock('@/main/config', () => ({getHclawDir: () => '/tmp/hclaw-test'}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))
vi.mock('@/main/repositories/sqlite', () => ({getDatabase: () => ({})}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({systemSettingsRepo: {}}))
// CommandDispatcher 触及文件系统/插件目录：mock 为「无 plugin/user 命令」，迫使走到实体兜底
vi.mock('../../../../src/main/plugin/commands', () => ({
    CommandDispatcher: {
        getInstance: () => ({
            refresh: async () => {},
            prepareMessageByName: () => null,
            getAllCommands: () => ({pluginGroups: new Map(), userCommands: []}),
        }),
    },
}))

import {detectCommandContext} from '@/main/agent/loop/setup'
import type {RunParams} from '@/main/agent/loop/types'
import {skillRegistry} from '@/main/agent/skills/registry'
import {agentRegistry} from '@/main/agent/agentRegistry'
import type {SkillDefinition} from '@/main/agent/skills/types'
import type {AgentTemplate} from '@shared/types'

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
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

/** 构造最小 RunParams：只用到 messages（onEvent 省略 → 不应触达事件） */
function makeParams(messages: RunParams['messages']): RunParams {
    return {messages} as unknown as RunParams
}

function userMessage(text: string, commandId?: string): RunParams['messages'][number] {
    return {
        role: 'user',
        content: text,
        ...(commandId ? {metadata: {commandId}} : {}),
    } as RunParams['messages'][number]
}

describe('detectCommandContext — metadata.commandId 技能兜底', () => {
    beforeEach(() => {
        skillRegistry.clear()
        agentRegistry.clear()
    })
    afterEach(() => {
        skillRegistry.clear()
        agentRegistry.clear()
    })

    it('C1 无 / 正文 + commandId=skill:<id> → 命中技能模板，commandArgs 为正文全文', async () => {
        skillRegistry.register(makeSkill({id: 'systematic-debugging', name: 'Systematic Debugging'}))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('这个 bug 帮我看看', 'skill:systematic-debugging')]),
        )

        expect(commandContext).not.toBeNull()
        expect(commandContext!.commandId).toBe('skill:systematic-debugging')
        expect(commandContext!.commandTemplate).toContain('# 技能模式: Systematic Debugging')
        expect(commandContext!.commandArgs).toBe('这个 bug 帮我看看')
    })

    it('C2 无 / 正文 + 无 commandId → null（边界/防误伤：无命令来源不得仅凭正文形态触发注入）', async () => {
        skillRegistry.register(makeSkill({id: 'systematic-debugging', name: 'Systematic Debugging'}))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('这个 bug 帮我看看')]),
        )

        expect(commandContext).toBeNull()
    })

    it('C3 无 / 正文 + commandId=agent:xxx → null（边界/防误伤：agent 走既有 resolveAgentDefinitionForTurn 分支，此处不得命中）', async () => {
        agentRegistry.register(makeAgent({id: 'explore', name: 'Explore Agent'}))
        // 同名技能即使存在也不得命中（前缀不是 skill:）
        skillRegistry.register(makeSkill({id: 'explore', name: 'Explore Skill'}))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('去看一下代码', 'agent:explore')]),
        )

        expect(commandContext).toBeNull()
    })

    it('C4 正文以 / 开头 → 原路径（正文优先，命令名/参数按正文解析）', async () => {
        skillRegistry.register(makeSkill({id: 'brainstorming', name: 'Brainstorming'}))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('/brainstorming\n我想设计一个功能')]),
        )

        expect(commandContext).not.toBeNull()
        expect(commandContext!.commandName).toBe('brainstorming')
        expect(commandContext!.commandArgs).toBe('我想设计一个功能')
        expect(commandContext!.commandId).toBe('skill:brainstorming')
        expect(commandContext!.commandTemplate).toContain('# 技能模式: Brainstorming')
    })

    it('C5 无 / 正文 + commandId=skill:<未注册名> → null（边界/防误伤：解析不到实体时不注入）', async () => {
        skillRegistry.register(makeSkill({id: 'systematic-debugging', name: 'Systematic Debugging'}))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('随便聊聊', 'skill:no-such-skill')]),
        )

        expect(commandContext).toBeNull()
    })

    it('C6 无 / 正文 + commandId=skill:<已注册但 enabled=false> → null（边界/防误伤：禁用技能不得注入）', async () => {
        skillRegistry.register(makeSkill({
            id: 'systematic-debugging',
            name: 'Systematic Debugging',
            enabled: false,
        }))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('这个 bug 帮我看看', 'skill:systematic-debugging')]),
        )

        expect(commandContext).toBeNull()
    })

    // ── Round 3（W1）：命令来源权威化 ──────────────────────────

    it('N1 commandId=skill:X + 正文 /otherSkill → 命中 X（metadata 权威，正文不参与解析）', async () => {
        skillRegistry.register(makeSkill({id: 'systematic-debugging', name: 'Systematic Debugging'}))
        skillRegistry.register(makeSkill({id: 'brainstorming', name: 'Brainstorming'}))

        const {commandContext} = await detectCommandContext(
            makeParams([
                userMessage('/brainstorming\n我想设计一个功能', 'skill:systematic-debugging'),
            ]),
        )

        expect(commandContext).not.toBeNull()
        expect(commandContext!.commandId).toBe('skill:systematic-debugging')
        expect(commandContext!.commandName).toBe('Systematic Debugging')
        expect(commandContext!.commandTemplate).toContain('# 技能模式: Systematic Debugging')
        expect(commandContext!.commandArgs).toBe('/brainstorming\n我想设计一个功能')
    })

    it('N2 commandId=agent:Y + 正文 /otherSkill → null（agent 权威，不得命中正文里的技能）', async () => {
        agentRegistry.register(makeAgent({id: 'local-general', name: 'General Agent'}))
        skillRegistry.register(makeSkill({id: 'brainstorming', name: 'Brainstorming'}))

        const {commandContext} = await detectCommandContext(
            makeParams([
                userMessage('/brainstorming\n我想设计一个功能', 'agent:local-general'),
            ]),
        )

        expect(commandContext).toBeNull()
    })

    it('N3 commandId=plugin:z + 正文 /otherSkill → 仍走正文解析（现状回归）', async () => {
        skillRegistry.register(makeSkill({id: 'brainstorming', name: 'Brainstorming'}))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('/brainstorming\n我想设计一个功能', 'plugin:z')]),
        )

        expect(commandContext).not.toBeNull()
        expect(commandContext!.commandId).toBe('skill:brainstorming')
        expect(commandContext!.commandName).toBe('brainstorming')
        expect(commandContext!.commandArgs).toBe('我想设计一个功能')
    })

    it('N4 无 commandId + 正文 /<skill> → 仍走正文解析（现状回归）', async () => {
        skillRegistry.register(makeSkill({id: 'brainstorming', name: 'Brainstorming'}))

        const {commandContext} = await detectCommandContext(
            makeParams([userMessage('/brainstorming 我想设计一个功能')]),
        )

        expect(commandContext).not.toBeNull()
        expect(commandContext!.commandId).toBe('skill:brainstorming')
        expect(commandContext!.commandArgs).toBe('我想设计一个功能')
    })
})
