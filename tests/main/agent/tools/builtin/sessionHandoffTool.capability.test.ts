/**
 * session_handoff 工具 — capability 语义测试（只解析技能，未命中静默不注入）
 *
 * 验证：
 * 1. capability = agent 名 → 首条消息不以 `/` 开头、metadata 无 commandId、success:true、output 含「未匹配」提示
 * 2. capability = 技能名 → 首条消息以 `/${规范名}\n` 开头、metadata.commandId 为 `skill:...`
 * 3. capability 省略 → 首条消息 = handoffSummary 原文
 *
 * mock 边界：repositories、runtimeConfigManager、worker_threads（捕获 session_handoff_start payload）；
 * entityCommandResolver 连带加载的 config / sqlite 纯副作用模块（TDZ 规避，与 skills/loader.test.ts 同策略）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

const {createMock, readMetaMock, writeMessagesMock, postMessageMock, migrateActiveBatchMock} = vi.hoisted(() => ({
    createMock: vi.fn((_convId: string, _meta: Record<string, unknown>) => true),
    readMetaMock: vi.fn((_convId: string) => ({workspacePath: '/ws'} as Record<string, unknown> | null)),
    writeMessagesMock: vi.fn((_convId: string, _messages: unknown[]) => true),
    postMessageMock: vi.fn((_msg: unknown) => undefined),
    migrateActiveBatchMock: vi.fn(),
}))

vi.mock('worker_threads', () => ({
    parentPort: {postMessage: postMessageMock},
}))

vi.mock('../../../../../src/main/repositories', () => ({
    createConversationRepository: () => ({
        create: createMock,
        readMeta: readMetaMock,
        writeMessages: writeMessagesMock,
    }),
}))

vi.mock('../../../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getPrimaryProvider: () => ({isValid: true}),
    },
}))

vi.mock('@/main/config', () => ({getHclawDir: () => '/tmp/hclaw-test'}))
vi.mock('@/main/repositories/sqlite', () => ({getDatabase: () => ({})}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({systemSettingsRepo: {}}))
// 交接迁移走真实 sqlite（getDatabase 被上面 mock 成 {}），单独 mock 掉批次迁移
vi.mock('../../../../../src/main/repositories/sqlite/taskBatchRepository', () => ({
    migrateActiveBatch: migrateActiveBatchMock,
}))

import {sessionHandoffTool} from '../../../../../src/main/agent/tools/builtin/sessionHandoffTool'
import {skillRegistry} from '@/main/agent/skills/registry'
import {agentRegistry} from '@/main/agent/agentRegistry'
import type {SkillDefinition} from '@/main/agent/skills/types'
import type {AgentTemplate} from '@shared/types'

const SKILL: SkillDefinition = {
    id: 'brainstorming',
    name: 'Brainstorming',
    description: '头脑风暴',
    enabled: true,
    content: '技能正文',
    loadedAt: 0,
}
const AGENT: AgentTemplate = {
    id: 'explore',
    name: 'Explore Agent',
    description: '探索',
    systemPrompt: 'system prompt',
    enabled: true,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
}

/** writeMessages 落库消息的最小断言形状 */
type WrittenMsg = {content: string; metadata?: {commandId?: string}}

describe('session_handoff Tool — capability 只解析技能', () => {
    const baseArgs = {
        title: '交接新会话',
        handoffSummary:
            '## 任务目标\n测试\n## 已完成进度\n无\n## 遗留问题\n无\n## 下一步计划\n继续\n## 关键上下文\n无',
    }
    type ExecCtx = Parameters<typeof sessionHandoffTool.execute>[1]
    const makeCtx = (conversationId: string) => ({conversationId}) as unknown as ExecCtx

    beforeEach(() => {
        vi.clearAllMocks()
        createMock.mockReturnValue(true)
        readMetaMock.mockReturnValue({workspacePath: '/ws'})
        writeMessagesMock.mockReturnValue(true)
        skillRegistry.clear()
        agentRegistry.clear()
        skillRegistry.register(SKILL)
        agentRegistry.register(AGENT)
    })
    afterEach(() => {
        skillRegistry.clear()
        agentRegistry.clear()
    })

    it('capability = agent 名 → 不拼前缀、无 commandId、success:true、output 含未匹配提示', async () => {
        const result = await sessionHandoffTool.execute(
            {...baseArgs, capability: 'Explore Agent'},
            makeCtx('conv-src'),
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain("capability 'Explore Agent' 未匹配到技能")

        const [, msgs] = writeMessagesMock.mock.calls[0] as [string, WrittenMsg[]]
        expect(msgs[0].content).toBe(baseArgs.handoffSummary)
        expect(msgs[0].content.startsWith('/')).toBe(false)
        expect(msgs[0].metadata?.commandId).toBeUndefined()

        const start = startPostMsg(startPostCalls())
        expect(start!.messages![0].content).toBe(baseArgs.handoffSummary)
    })

    it('capability = 技能名 → 前缀用规范名、metadata.commandId = skill:...', async () => {
        const result = await sessionHandoffTool.execute(
            {...baseArgs, capability: 'brainstorming'},
            makeCtx('conv-src'),
        )

        expect(result.success).toBe(true)
        expect(result.output).not.toContain('未匹配')

        const expectedContent = `/Brainstorming\n${baseArgs.handoffSummary}`
        const [, msgs] = writeMessagesMock.mock.calls[0] as [string, WrittenMsg[]]
        expect(msgs[0].content).toBe(expectedContent)
        expect(msgs[0].metadata?.commandId).toBe('skill:brainstorming')

        const start = startPostMsg(startPostCalls())
        expect(start!.messages![0].content).toBe(expectedContent)
    })

    it('capability 省略 → 首条消息 = handoffSummary 原文，无 commandId', async () => {
        await sessionHandoffTool.execute(baseArgs, makeCtx('conv-src'))

        const [, msgs] = writeMessagesMock.mock.calls[0] as [string, WrittenMsg[]]
        expect(msgs[0].content).toBe(baseArgs.handoffSummary)
        expect(msgs[0].metadata?.commandId).toBeUndefined()

        const start = startPostMsg(startPostCalls())
        expect(start!.messages![0].content).toBe(baseArgs.handoffSummary)
    })

    // ── helpers ──
    function startPostCalls(): Array<{type?: string; messages?: Array<{content: unknown}>}> {
        return postMessageMock.mock.calls.map(c => c[0] as {type?: string; messages?: Array<{content: unknown}>})
    }
    function startPostMsg(calls: Array<{type?: string; messages?: Array<{content: unknown}>}>) {
        return calls.find(m => m.type === 'session_handoff_start')
    }
})
