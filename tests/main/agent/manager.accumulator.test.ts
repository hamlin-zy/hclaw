import {describe, expect, it} from 'vitest'
import {accumulateStreamEvent, normalizeToolResult} from '@/main/agent/manager.accumulator'
import type {PendingAssistantMsg} from '@/main/agent/manager.types'

function makePending(toolName: string, toolCallId = 'tc-1'): PendingAssistantMsg {
    return {
        id: 'msg-1',
        content: '',
        toolCalls: [{
            id: toolCallId,
            name: toolName,
            arguments: {},
            status: 'running',
        }],
        thinkContent: null,
        timestamp: 1000,
    }
}

describe('normalizeToolResult — 保留 _meta（需求1 链路）', () => {
    it('agent 工具结果携带 _meta.childConvId 时保留', () => {
        const r = normalizeToolResult({output: 'ok', success: true, _meta: {childConvId: 'conv-abc'}})
        expect(r.output).toBe('ok')
        expect(r._meta).toEqual({childConvId: 'conv-abc'})
    })

    it('无 _meta 时返回对象不含 _meta 字段（回归）', () => {
        const r = normalizeToolResult({output: 'x'})
        expect(r._meta).toBeUndefined()
    })

    it('null 输入返回空 output 且无 _meta（回归）', () => {
        const r = normalizeToolResult(null)
        expect(r.output).toBe('')
        expect(r._meta).toBeUndefined()
    })
})

describe('accumulateStreamEvent — tool_result 分支写入 taskId（双轨一致性，impl 同步修改）', () => {
    it('agent 工具：从 result._meta 恢复 taskId', () => {
        const pending = makePending('agent')
        const turnReset = new Set<string>()
        const out = accumulateStreamEvent(pending, 'conv-root', {
            type: 'tool_result',
            toolCallId: 'tc-1',
            result: {output: 'ok', success: true, _meta: {childConvId: 'conv-abc'}},
        } as any, turnReset)
        expect(out?.toolCalls[0].taskId).toBe('conv-abc')
        expect(out?.toolCalls[0].status).toBe('success')
        expect(out?.toolCalls[0].result?._meta).toEqual({childConvId: 'conv-abc'})
    })

    it('非 agent 工具不写入 taskId（回归）', () => {
        const pending = makePending('bash')
        const out = accumulateStreamEvent(pending, 'conv-root', {
            type: 'tool_result',
            toolCallId: 'tc-1',
            result: {output: 'ok', success: true, _meta: {childConvId: 'conv-abc'}},
        } as any, new Set<string>())
        expect(out?.toolCalls[0].taskId).toBeUndefined()
    })

    it('toolCallId 不存在时保持 pending 不变（回归）', () => {
        const pending = makePending('agent')
        const out = accumulateStreamEvent(pending, 'conv-root', {
            type: 'tool_result',
            toolCallId: 'no-such-id',
            result: {output: 'ok'},
        } as any, new Set<string>())
        expect(out).toBe(pending)
        expect(out?.toolCalls[0].taskId).toBeUndefined()
    })
})
