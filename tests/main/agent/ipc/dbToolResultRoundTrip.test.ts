/**
 * DB 序列化 round-trip 测试 — messageToBlocks → blocksToMessage 全链路
 *
 * 验证 tool_result 经过真实 SQLite block 序列化（JSON.stringify → parse）后，
 * 重建出的 toolResult 与 loop 内存态逐字节一致。这是 historyConverter 测试
 * 无法覆盖的层：JSON 序列化本身可能丢失字段或改变类型。
 *
 * 写法对齐既有 messageBlockHelper.test.ts：直接调用 messageToBlocks / blocksToMessage，
 * 不依赖真实 SQLite 实例（纯函数级 round-trip）。
 */
import {describe, expect, it} from 'vitest'
import {messageToBlocks, blocksToMessage} from '@/main/repositories/sqlite/messageBlockHelper'
import {createToolResultMessage} from '@/main/agent/state'
import {convertAssistantHistoryMessage} from '@/main/agent/ipc/historyConverter'
import type {Message} from '@shared/types'

/** 构造一条带 contentBlocks 的 assistant 消息，落库后读回，再走 historyConverter 重建 */
function dbRoundTrip(result: {success: boolean; output: unknown; error?: string}) {
    // loop 内存态
    const memoryMsg = createToolResultMessage('tc-1', 'bash', result)

    // 构造 assistant 消息（contentBlocks 形态，与 manager.impl 落库一致）
    const msg: Message = {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: 1000,
        contentBlocks: [{
            id: 'cb-tc1',
            type: 'tool_use',
            toolCall: {
                id: 'tc-1',
                name: 'bash',
                arguments: {},
                status: result.success ? 'success' : 'error',
                result: {
                    success: result.success,
                    output: result.output,
                    error: result.error,
                    toolResult: memoryMsg.toolResult,
                },
            },
        }],
    }

    // 落库 → 读回（完整序列化/反序列化）
    const {messages: [record], blocks} = messageToBlocks(msg, 'conv-1')
    const restored = blocksToMessage(record, blocks)

    // 重建
    const rebuiltMsg = convertAssistantHistoryMessage(restored).find(m => m.role === 'tool')
    return {memoryMsg, restored, rebuiltMsg}
}

describe('DB 序列化 round-trip（messageToBlocks → blocksToMessage）', () => {
    it('成功字符串输出：重建 toolResult 与 loop 内存态一致', () => {
        const {memoryMsg, rebuiltMsg} = dbRoundTrip({success: true, output: 'hello db'})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe('hello db')
    })

    it('成功对象输出：序列化后对象格式不丢失', () => {
        const obj = {files: ['a.txt'], count: 1}
        const {memoryMsg, rebuiltMsg} = dbRoundTrip({success: true, output: obj})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe(JSON.stringify(obj, null, 2))
    })

    it('失败+错误：序列化后 [ERROR] 前缀保留', () => {
        const {memoryMsg, rebuiltMsg} = dbRoundTrip({success: false, output: null, error: 'db fail'})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe('[ERROR] db fail')
        expect(rebuiltMsg?.isError).toBe(true)
    })

    it('失败+错误+输出：换行拼接保留', () => {
        const {rebuiltMsg} = dbRoundTrip({success: false, output: 'out', error: 'err'})
        expect(rebuiltMsg?.toolResult).toBe('[ERROR] err\nout')
    })

    it('扁平字段路径（无 contentBlocks）：重建后 tool 消息存在', () => {
        const memoryMsg = createToolResultMessage('tc-1', 'bash', {success: true, output: 'flat'})
        expect(memoryMsg.toolResult).toBe('flat')
        const msg: Message = {
            id: 'm2',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [{
                id: 'tc-1',
                name: 'bash',
                arguments: {},
                status: 'success',
                result: {success: true, output: 'flat', toolResult: memoryMsg.toolResult},
            }],
        }
        const {messages: [record], blocks} = messageToBlocks(msg, 'conv-1')
        const restored = blocksToMessage(record, blocks)
        const rebuilt = convertAssistantHistoryMessage(restored).find(m => m.role === 'tool')
        expect(rebuilt?.toolResult).toBe('flat')
    })
})
