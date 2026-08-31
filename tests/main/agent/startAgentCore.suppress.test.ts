/**
 * startAgentCore — suppressUserMessage 分支 + 渠道结构化附件重建等价性
 *
 * suppressUserMessage: true 时（渠道/scheduler 场景）调用方已自行落库 user 消息，
 * startAgentCore 仅从 DB 历史重建上下文，不重推 params.message。
 * 渠道消息走 metadata.attachments 结构化附件 → 经 DB 历史重建后 user content
 * 须含附件描述文本（与 renderer 附件链路等价）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

vi.mock('@/main/agent/manager', () => ({agentManager: {start: vi.fn().mockResolvedValue(undefined)}}))
vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: vi.fn(() => ({
            id: 's1', name: 'test',
            roles: [{role: 'reasoning', enabled: true, endpointId: 'e1', modelId: 'm1'}],
        })),
        getProviders: vi.fn(() => []),
    },
}))
// 可变 DB 历史快照（各用例可覆写，默认 user+assistant，模拟真实会话末尾有回复）
let dbMessages: any[] = [
    {
        id: 'u1', role: 'user', content: '分析附件', timestamp: 1,
        metadata: {attachments: [{path: 'E:/a.png', name: 'a.png'}]},
        // DB 读回约定：buildMessagesFromRows 将 metadata 展开到消息顶层
        attachments: [{path: 'E:/a.png', name: 'a.png'}],
    },
    {id: 'a1', role: 'assistant', content: 'ok', timestamp: Date.now()},
]

vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({
        readMessages: vi.fn(() => dbMessages),
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

describe('startAgentCore — suppressUserMessage 与附件重建等价性', () => {
    beforeEach(() => {
        vi.mocked(agentManager.start).mockClear()
        dbMessages = [
            {
                id: 'u1', role: 'user', content: '分析附件', timestamp: 1,
                metadata: {attachments: [{path: 'E:/a.png', name: 'a.png'}]},
                attachments: [{path: 'E:/a.png', name: 'a.png'}],
            },
            {id: 'a1', role: 'assistant', content: 'ok', timestamp: Date.now()},
        ]
    })

    it('为 false（默认）时重推 params.message，末条 user 为待发送消息', async () => {
        await startAgentCore({conversationId: 'c', message: '分析附件'}, 'channel')
        const call = vi.mocked(agentManager.start).mock.calls[0][0]
        const last = call.messages[call.messages.length - 1]
        expect(last.role).toBe('user')
        expect(last.content).toBe('分析附件')
    })

    it('为 true 时不重推 params.message，末条 user 来自 DB 重建', async () => {
        await startAgentCore({conversationId: 'c', message: '本轮新指令', suppressUserMessage: true}, 'channel')
        const call = vi.mocked(agentManager.start).mock.calls[0][0]
        const users = call.messages.filter((m: any) => m.role === 'user')
        // DB 中仅 1 条 user，且未被 params.message 重推（否则出现 2 条，末条为"本轮新指令"）
        expect(users.length).toBe(1)
        expect(call.messages[call.messages.length - 1].role).toBe('assistant')
        expect(JSON.stringify(call.messages)).not.toContain('本轮新指令')
    })

    it('suppress 下渠道结构化附件（metadata.attachments）经 DB 历史重建后 user content 含附件描述文本', async () => {
        await startAgentCore({conversationId: 'c', message: '分析附件', suppressUserMessage: true}, 'channel')
        const call = vi.mocked(agentManager.start).mock.calls[0][0]
        const rebuilt = call.messages.find((m: any) => m.role === 'user' && m.id === 'u1')
        expect(rebuilt).toBeDefined()
        if (!rebuilt) return
        const text = typeof rebuilt.content === 'string'
            ? rebuilt.content
            : rebuilt.content.map((p: any) => p.text || '').join('')
        // 与 renderer 附件链路等价：含附件路径/文件名描述（本地图片读取失败回退文本）
        expect(text).toContain('分析附件')
        expect(text).toContain('E:/a.png')
    })

    it('suppress=true 且 DB 末条 user content === params.message 时不去重，消息保留', async () => {
        // 模拟渠道真实场景：先落库 user（末条即本次消息），再 suppressUserMessage 调用
        dbMessages = [{
            id: 'u2', role: 'user', content: '本轮新指令', timestamp: Date.now(),
        }]
        await startAgentCore({conversationId: 'c', message: '本轮新指令', suppressUserMessage: true}, 'channel')
        const call = vi.mocked(agentManager.start).mock.calls[0][0]
        const last = call.messages[call.messages.length - 1]
        expect(last.role).toBe('user')
        const text = typeof last.content === 'string'
            ? last.content
            : last.content.map((p: any) => p.text || '').join('')
        expect(text).toContain('本轮新指令')
    })
})

