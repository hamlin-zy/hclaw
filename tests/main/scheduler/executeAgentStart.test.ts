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
        getProviders: vi.fn(() => []),
    },
}))
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({
        readMessages: vi.fn(() => [
            {id: 'u1', role: 'user', content: '每日站会摘要', timestamp: Date.now()},
        ]),
        readMeta: vi.fn(() => ({workspacePath: 'E:/ws'})),
        getSystemPrompt: vi.fn(() => null),
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
})
