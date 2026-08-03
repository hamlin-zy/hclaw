/**
 * agentTool.resolveChildAssistantMessage 单元测试
 *
 * 覆盖 a79c2af（子会话防重复 assistant 消息落库）提取出的纯函数行为：
 * - 已有流式 assistant 消息且无 llmStats → 只补写 llmStats，不追加新消息
 * - 已有流式 assistant 消息且已有 llmStats → 不写（返回 null）
 * - 已有流式 assistant 消息且无 childLlmStats → 不写（返回 null）
 * - 无 assistant 消息 → 兜底写入完整结果（含 llmStats 条件附加）
 * - 无 assistant 消息且无 llmStats → 兜底写入完整结果（不含 llmStats）
 *
 * 纯函数隔离：不依赖任何主进程模块，仅输入 Message[] 与参数。
 */
import {describe, expect, it} from 'vitest'
import type {Message, LlmStats} from '@shared/types/message'
import {resolveChildAssistantMessage} from '@/main/agent/tools/builtin/agentTool'

const FIXED_NOW = 1700000000000

function makeAssistant(id: string, content: string, llmStats?: LlmStats[]): Message {
    return {
        id,
        role: 'assistant',
        content,
        timestamp: FIXED_NOW,
        ...(llmStats ? {llmStats} : {}),
    }
}

function makeUser(id: string, content: string): Message {
    return {id, role: 'user', content, timestamp: FIXED_NOW}
}

const STATS: LlmStats[] = [{
    inputTokens: 100,
    outputTokens: 50,
    provider: 'anthropic',
    model: 'claude',
    duration: 1000,
}]

describe('resolveChildAssistantMessage（子会话防重复 assistant 落库）', () => {
    it('已有流式 assistant 消息且无 llmStats → 只补写 llmStats，保留原 id/content', () => {
        const existing = [makeUser('u1', 'task'), makeAssistant('uuid-msg', 'final output')]
        const result = resolveChildAssistantMessage(existing, 'final output', STATS, FIXED_NOW)

        expect(result).not.toBeNull()
        expect(result!.id).toBe('uuid-msg')
        expect(result!.content).toBe('final output')
        expect(result!.llmStats).toEqual(STATS)
        // 不生成新 msg-<ts> id
        expect(result!.id).not.toMatch(/^msg-/)
    })

    it('已有流式 assistant 消息且已有 llmStats → 不写（返回 null）', () => {
        const existing = [makeAssistant('uuid-msg', 'final output', STATS)]
        const result = resolveChildAssistantMessage(existing, 'final output', STATS, FIXED_NOW)
        expect(result).toBeNull()
    })

    it('已有流式 assistant 消息但 childLlmStats 为空 → 不写（返回 null）', () => {
        const existing = [makeAssistant('uuid-msg', 'final output')]
        const result = resolveChildAssistantMessage(existing, 'final output', [], FIXED_NOW)
        expect(result).toBeNull()
    })

    it('多个 assistant 消息时取最后一条补写', () => {
        const existing = [
            makeAssistant('first', 'previous', STATS),
            makeAssistant('last', 'final output'),
        ]
        const result = resolveChildAssistantMessage(existing, 'final output', STATS, FIXED_NOW)
        expect(result!.id).toBe('last')
        expect(result!.llmStats).toEqual(STATS)
    })

    it('无 assistant 消息 → 兜底写入完整结果（含 llmStats）', () => {
        const existing = [makeUser('u1', 'task')]
        const result = resolveChildAssistantMessage(existing, 'final output', STATS, FIXED_NOW)

        expect(result).not.toBeNull()
        expect(result!.id).toMatch(/^msg-/)
        expect(result!.role).toBe('assistant')
        expect(result!.content).toBe('final output')
        expect(result!.timestamp).toBe(FIXED_NOW)
        expect(result!.llmStats).toEqual(STATS)
    })

    it('无 assistant 消息且无 llmStats → 兜底写入但不含 llmStats 字段', () => {
        const existing: Message[] = []
        const result = resolveChildAssistantMessage(existing, '(无输出)', [], FIXED_NOW)

        expect(result).not.toBeNull()
        expect(result!.content).toBe('(无输出)')
        expect(result!.llmStats).toBeUndefined()
        // 验证不携带空数组（避免落库冗余字段）
        expect('llmStats' in result!).toBe(false)
    })
})
