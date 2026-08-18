/**
 * tool_result 三端一致性 round-trip 测试
 *
 * 目标：保证「loop 内存态 → 落库存储 → 历史重建」三端的 tool_result 字符串
 * 逐字节一致，使跨 turn 重建后的 API 请求前缀与上一轮 loop 末逐 token 相同，
 * 最大化 DeepSeek / Anthropic 前缀缓存命中。
 *
 * 链路：
 *   1. loop 内存态：createToolResultMessage(toolCallId, toolName, result)
 *   2. 落库存储：normalizeToolResult(result) → tc.result
 *   3. 历史重建：historyConverter.toolResultMessage(tc)（经 convertAssistantHistoryMessage）
 *
 * 断言：链尾重建出的 toolResult 与链首 loop 内存态的 toolResult 完全相等。
 */
import {describe, expect, it} from 'vitest'
import {createToolResultMessage} from '@/main/agent/state'
import {normalizeToolResult} from '@/main/agent/manager.accumulator'
import {convertAssistantHistoryMessage} from '@/main/agent/ipc/historyConverter'

/** 模拟完整 round-trip：执行 loop 内存态 → 落库 → blocksToMessage 恢复 → historyConverter 重建 */
function roundTrip(result: {success: boolean; output: unknown; error?: string}) {
    // 1. loop 内存态
    const memoryMsg = createToolResultMessage('tc-1', 'bash', result)

    // 2. 落库存储（pending.toolCalls[].result 走 normalizeToolResult）
    const stored = normalizeToolResult(result)

    // 3. 重建：构造 historyConverter 输入（模拟 blocksToMessage 恢复的 toolCall）
    const rebuiltMsg = convertAssistantHistoryMessage({
        role: 'assistant',
        content: '',
        contentBlocks: [{
            id: 'cb-1',
            type: 'tool_use',
            toolCall: {
                id: 'tc-1',
                name: 'bash',
                arguments: {},
                status: stored.success ? 'success' : 'error',
                result: stored,
            },
        }],
    }).find(m => m.role === 'tool')

    return {memoryMsg, stored, rebuiltMsg}
}

describe('tool_result 三端一致性（loop 内存态 = 存储 = 重建）', () => {
    it('成功 + 字符串输出：三端 toolResult 一致', () => {
        const {memoryMsg, rebuiltMsg} = roundTrip({success: true, output: 'hello world'})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe('hello world')
        expect(rebuiltMsg?.isError).toBe(false)
    })

    it('成功 + 对象输出：对象格式在三端一致（不再 [object Object]）', () => {
        const objOutput = {files: ['a.txt', 'b.txt'], count: 2}
        const {memoryMsg, rebuiltMsg} = roundTrip({success: true, output: objOutput})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe(JSON.stringify(objOutput, null, 2))
    })

    it('成功 + 数组输出：三端一致', () => {
        const arrOutput = ['a', 'b', 'c']
        const {memoryMsg, rebuiltMsg} = roundTrip({success: true, output: arrOutput})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe(JSON.stringify(arrOutput, null, 2))
    })

    it('失败 + 有错误：三端一致（[ERROR] 前缀 + 输出拼接）', () => {
        const {memoryMsg, rebuiltMsg} = roundTrip({success: false, output: null, error: 'command not found'})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe('[ERROR] command not found')
        expect(rebuiltMsg?.isError).toBe(true)
    })

    it('失败 + 有错误 + 有输出：三端一致（错误在前、输出换行在后）', () => {
        const {memoryMsg, rebuiltMsg} = roundTrip({success: false, output: 'partial output', error: 'failed'})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe('[ERROR] failed\npartial output')
    })

    it('失败 + 无错误信息：三端一致（无 [ERROR] 前缀，空内容）', () => {
        const {memoryMsg, rebuiltMsg} = roundTrip({success: false, output: '', error: undefined})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe('')
    })

    it('成功 + 空字符串输出：成功判据不受输出为空影响（不误判为 error）', () => {
        const {memoryMsg, rebuiltMsg} = roundTrip({success: true, output: ''})
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.isError).toBe(false)
        expect(memoryMsg.isError).toBe(false)
    })

    it('权限拒绝：重建为 [ERROR] [PERMISSION_DENIED] 前缀（与 loop 内存态一致）', () => {
        const deniedResult = {success: false, output: null, error: '[PERMISSION_DENIED] 用户已拒绝执行该操作'}
        const {memoryMsg, rebuiltMsg} = roundTrip(deniedResult)
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe('[ERROR] [PERMISSION_DENIED] 用户已拒绝执行该操作')
    })

    it('中断/丢结果：重建生成 [INTERRUPTED] 合成文案（与 normalizeToolCallMessages 一致）', () => {
        const rebuilt = convertAssistantHistoryMessage({
            role: 'assistant',
            content: '',
            contentBlocks: [{
                id: 'cb-1',
                type: 'tool_use',
                toolCall: {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}, // 无 result
            }],
        }).find(m => m.role === 'tool')
        expect(rebuilt?.toolResult).toBe('[INTERRUPTED] 工具调用被中断，未获取到执行结果（tool: bash）')
        expect(rebuilt?.isError).toBe(true)
    })

    it('functionName 字段保留（与 loop 内存态 createToolResultMessage 一致）', () => {
        const {memoryMsg, rebuiltMsg} = roundTrip({success: true, output: 'ok'})
        expect(memoryMsg.functionName).toBe('bash')
        expect(rebuiltMsg?.functionName).toBe('bash')
    })
})

describe('旧数据回退（无 toolResult 字段）', () => {
    it('旧格式 {output, error}：回退 formatToolResult 算法，与 loop 内存态一致', () => {
        const memoryMsg = createToolResultMessage('tc-1', 'bash', {success: true, output: {a: 1}})
        // 旧数据：result 只有 {output, error}，无 toolResult
        const rebuiltMsg = convertAssistantHistoryMessage({
            role: 'assistant',
            content: '',
            contentBlocks: [{
                id: 'cb-1',
                type: 'tool_use',
                toolCall: {
                    id: 'tc-1',
                    name: 'bash',
                    arguments: {},
                    status: 'success',
                    result: {output: {a: 1}},
                },
            }],
        }).find(m => m.role === 'tool')
        expect(rebuiltMsg?.toolResult).toBe(memoryMsg.toolResult)
        expect(rebuiltMsg?.toolResult).toBe(JSON.stringify({a: 1}, null, 2))
    })

    it('旧格式 纯字符串 result：原样回传', () => {
        const rebuiltMsg = convertAssistantHistoryMessage({
            role: 'assistant',
            content: '',
            contentBlocks: [{
                id: 'cb-1',
                type: 'tool_use',
                toolCall: {
                    id: 'tc-1',
                    name: 'bash',
                    arguments: {},
                    status: 'success',
                    result: 'legacy string result',
                },
            }],
        }).find(m => m.role === 'tool')
        expect(rebuiltMsg?.toolResult).toBe('legacy string result')
        expect(rebuiltMsg?.isError).toBe(false)
    })
})
