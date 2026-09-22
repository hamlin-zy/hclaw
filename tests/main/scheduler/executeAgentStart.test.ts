/**
 * 冒烟：scheduler 路径经 startAgentCore 启动后，workerParams.messages
 * 以「重建的历史 + 本次 user 消息」结尾，而非 scheduler 手拼的单条消息。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

vi.mock('@/main/agent/manager', () => ({
    agentManager: {start: vi.fn().mockResolvedValue(undefined)},
}))
vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: vi.fn(() => ({
            id: 's1', name: 'test',
            roles: [{role: 'reasoning', enabled: true, endpointId: 'e1', modelId: 'm1'}],
        })),
        getProviders: vi.fn(() => [
            // startAgentCore 会校验角色可用性（provider 存在且 enabled、模型存在且 enabled）
            {id: 'e1', enabled: true, models: [{id: 'm1', enabled: true}]},
        ] as any),
    },
}))
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({
        readMessages: vi.fn(() => [
            {id: 'u1', role: 'user', content: '每日站会摘要', timestamp: Date.now()},
        ]),
        readMeta: vi.fn(() => ({workspacePath: 'E:/ws'})),
        getSystemPrompt: vi.fn(() => null),
        // Task 7：user 消息落库改主进程 writeNow（渲染端停写熔断）
        writeMessagesDelta: vi.fn(() => true),
    }),
}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {getJson: vi.fn(() => undefined)},
}))
vi.mock('@/main/agent/tools/permission', () => ({permissionEngine: {getMode: vi.fn(async () => 'default')}}))
vi.mock('@/main/agent/agentTemplateConverter', () => ({resolveAgentDefinitionForTurn: vi.fn(() => undefined)}))
vi.mock('@/main/agent/logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))

import {startAgentCore} from '@/main/agent/startAgentCore'
import {agentManager} from '@/main/agent/manager'

describe('scheduler 统一启动入口冒烟', () => {
    beforeEach(() => {
        vi.mocked(agentManager.start).mockClear()
    })

    it('origin=scheduler 时经 core 启动，messages 末条为本次 user 且带生成 id', async () => {
        await startAgentCore({conversationId: 'conv-x', message: '每日站会摘要'}, 'scheduler')
        const call = vi.mocked(agentManager.start).mock.calls[0][0]
        const last = call.messages[call.messages.length - 1]
        expect(last.role).toBe('user')
        expect(last.content).toBe('每日站会摘要')
        expect(last.id).toMatch(/^msg-/)
        // 去重：DB 中已落库的同内容 user 不重复出现两次
        const users = call.messages.filter((m: any) => m.role === 'user' && m.content === '每日站会摘要')
        expect(users.length).toBe(1)
    })

    /**
     * 组 C · P1-8：cron / 交互路径首轮请求体字节确定
     *
     * 口径说明（重要）：system 与 tools **不在** startAgentCore 内构建（分别由 loop
     * 的 buildSystemPrompt / filterTools 在 worker 侧产出），本层可观测的是它们的**全部输入**：
     * workingDir、agentType/agentDefinition、messageMetadata.commandId、schemeConfig、messages。
     * 因此本文件锁两件事：
     *   ① 同参数两次启动 → workerParams 除「新 user 消息的随机 id」外逐字节相等；
     *   ② origin（scheduler / ipc）不参与行为分支 → 两条路径的输入逐字节相等，
     *      同一 (workspace, agentType) 下 system+tools 必然同字节（system 由 buildSystemPrompt
     *      纯函数 + 签名门控决定，tools 由 filterTools 依 modelId 决定，二者均不读 origin）。
     * 泄漏面：workerParams 里不得出现日期/毫秒戳形式的正文（随机 id 例外，它不进 LLM content）。
     */
    const stripVolatileIds = (p: {messages: Array<{id?: string}>}) =>
        JSON.stringify({...p, messages: p.messages.map(({id: _id, ...rest}) => rest)})

    it('同参数两次启动：workerParams 除新 user 随机 id 外逐字节相等（首轮请求体确定）', async () => {
        await startAgentCore({conversationId: 'conv-x', message: '每日站会摘要'}, 'scheduler')
        await startAgentCore({conversationId: 'conv-x', message: '每日站会摘要'}, 'scheduler')
        const [a, b] = vi.mocked(agentManager.start).mock.calls.map(c => c[0])

        expect(stripVolatileIds(a)).toBe(stripVolatileIds(b))
        // 新 user 消息的 id 之外，content 也不得随时间漂移
        const lastA = a.messages[a.messages.length - 1]
        expect(lastA.content).toBe('每日站会摘要')
        expect(String(lastA.content)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    })

    it('cron 与交互路径：origin 不影响启动输入（system+tools 的输入逐字节相同）', async () => {
        await startAgentCore({conversationId: 'conv-x', message: '每日站会摘要'}, 'scheduler')
        await startAgentCore({conversationId: 'conv-x', message: '每日站会摘要'}, 'renderer')
        const [cron, interactive] = vi.mocked(agentManager.start).mock.calls.map(c => c[0])

        expect(stripVolatileIds(cron)).toBe(stripVolatileIds(interactive))
        // 直接影响 system / tools 的输入字段逐一比对（任一漂移都会让两条路径前缀不同）
        expect(cron.workingDir).toBe(interactive.workingDir)
        expect(cron.messageMetadata).toEqual(interactive.messageMetadata)
        expect(JSON.stringify(cron.schemeConfig ?? null)).toBe(JSON.stringify(interactive.schemeConfig ?? null))
        expect(cron.agentDefinition ?? null).toEqual(interactive.agentDefinition ?? null)
    })
})
