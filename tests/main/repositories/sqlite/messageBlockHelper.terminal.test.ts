// @vitest-environment node
/**
 * 工具调用终态持久化回归测试（读侧）
 *
 * 覆盖 bug：tool_call 块在 tool_use 时以 status:'running' 落库，
 * tool_result 到达后只写 {id, result} 独立块，tool_call 块 status 从未更新。
 * 重启加载（blocksToMessage）时所有历史工具卡片显示"执行中"。
 *
 * 修复：加载时若工具已有 result（必然执行完毕）而 status 仍为 running/pending，
 * 按 result.success 推断终态（success/error）。
 */
import {describe, it, expect} from 'vitest'
import {blocksToMessage} from '../../../../src/main/repositories/sqlite/messageBlockHelper'
import type {Message, MessageBlock} from '../../../../src/shared/types'

function makeMsg() {
    return {id: 'm1', role: 'assistant' as const, timestamp: 1000} as Message
}

function makeToolCallBlock(status: string) {
    return {
        id: 'm1-tc-tc1',
        messageId: 'm1',
        blockType: 'tool_call',
        content: null,
        data: JSON.stringify({id: 'tc1', name: 'bash', arguments: {cmd: 'ls'}, status, textOffset: 0}),
        sequence: 0,
        timestamp: 1000,
    } as MessageBlock
}

function makeToolResultBlock(success: boolean, withError = false) {
    return {
        id: 'm1-tr-tc1',
        messageId: 'm1',
        blockType: 'tool_result',
        content: null,
        data: JSON.stringify({
            id: 'tc1',
            result: {
                success,
                output: success ? 'ok' : '',
                ...(withError ? {error: 'command failed'} : {}),
            },
        }),
        sequence: 1,
        timestamp: 1100,
    } as MessageBlock
}

describe('blocksToMessage 工具终态恢复（重启后不显示"执行中"）', () => {
    it('status=running + 成功 result → 恢复为 success', () => {
        const msg = blocksToMessage(makeMsg(), [makeToolCallBlock('running'), makeToolResultBlock(true)])
        const tc = msg.toolCalls![0]
        expect(tc.status).toBe('success')
        expect(tc.result).toBeTruthy()
        // contentBlocks 路径同样生效
        const cb = msg.contentBlocks!.find(b => b.type === 'tool_use')!
        expect(cb.toolCall!.status).toBe('success')
    })

    it('status=running + 失败 result → 恢复为 error', () => {
        const msg = blocksToMessage(makeMsg(), [makeToolCallBlock('running'), makeToolResultBlock(false, true)])
        expect(msg.toolCalls![0].status).toBe('error')
    })

    it('status=pending + result → 恢复为终态（pending 也不是终态）', () => {
        const msg = blocksToMessage(makeMsg(), [makeToolCallBlock('pending'), makeToolResultBlock(true)])
        expect(msg.toolCalls![0].status).toBe('success')
    })

    it('已是终态（success）→ 不被覆盖', () => {
        const msg = blocksToMessage(makeMsg(), [makeToolCallBlock('success'), makeToolResultBlock(true)])
        expect(msg.toolCalls![0].status).toBe('success')
    })

    it('无 tool_result 块（工具未完成/被中断）→ 保持 running', () => {
        const msg = blocksToMessage(makeMsg(), [makeToolCallBlock('running')])
        expect(msg.toolCalls![0].status).toBe('running')
    })

    it('旧路径扁平字段（无 contentBlocks）同样恢复终态', () => {
        const msg = blocksToMessage(makeMsg(), [
            {
                id: 'm1-tc-tc2', messageId: 'm1', blockType: 'tool_call', content: null,
                data: JSON.stringify({id: 'tc2', name: 'read', arguments: {}, status: 'running', textOffset: 10}),
                sequence: 2, timestamp: 1000,
            },
            {
                id: 'm1-tr-tc2', messageId: 'm1', blockType: 'tool_result', content: null,
                data: JSON.stringify({id: 'tc2', result: {success: false, output: '', error: 'boom'}}),
                sequence: 3, timestamp: 1100,
            },
        ])
        expect(msg.toolCalls!.find(t => t.id === 'tc2')!.status).toBe('error')
    })
})
