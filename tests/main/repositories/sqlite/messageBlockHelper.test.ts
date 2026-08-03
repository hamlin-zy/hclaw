import {describe, expect, it} from 'vitest'
import {blocksToMessage, messageToBlocks} from '@/main/repositories/sqlite/messageBlockHelper'
import type {Message} from '@shared/types'

describe('toolCallToBlock — 序列化 taskId/taskDescription（需求1 链路）', () => {
    it('tool_call block data 含 taskId 与 taskDescription', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [{
                id: 'tc-1',
                name: 'agent',
                arguments: {},
                status: 'running',
                taskId: 'conv-abc',
                taskDescription: '子任务',
            }],
        }
        const {blocks} = messageToBlocks(msg, 'conv-root')
        const tcBlock = blocks.find(b => b.blockType === 'tool_call')
        expect(tcBlock).toBeDefined()
        const data = JSON.parse(tcBlock!.data!)
        expect(data.taskId).toBe('conv-abc')
        expect(data.taskDescription).toBe('子任务')
    })

    it('blocksToMessage round-trip 还原 taskId', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [{
                id: 'tc-1',
                name: 'agent',
                arguments: {},
                status: 'running',
                taskId: 'conv-abc',
                taskDescription: '子任务',
            }],
        }
        const {messages: [record], blocks} = messageToBlocks(msg, 'conv-root')
        const restored = blocksToMessage(record, blocks)
        expect(restored.toolCalls?.[0].taskId).toBe('conv-abc')
        expect(restored.toolCalls?.[0].taskDescription).toBe('子任务')
    })

    it('无 taskId 的 toolCall 不引入脏字段（回归）', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [{id: 'tc-2', name: 'bash', arguments: {}, status: 'success'}],
        }
        const {blocks} = messageToBlocks(msg, 'conv-root')
        const tcBlock = blocks.find(b => b.blockType === 'tool_call')
        const data = JSON.parse(tcBlock!.data!)
        expect(data.taskId).toBeUndefined()
    })

    it('带 result 的 toolCall 生成 tool_call + tool_result 两个 block 且配对正确（回归）', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [{
                id: 'tc-3',
                name: 'bash',
                arguments: {},
                status: 'success',
                result: {output: 'done'},
            }],
        }
        const {messages: [record], blocks} = messageToBlocks(msg, 'conv-root')
        const blockTypes = blocks.map(b => b.blockType)
        expect(blockTypes).toContain('tool_call')
        expect(blockTypes).toContain('tool_result')
        const restored = blocksToMessage(record, blocks)
        expect(restored.toolCalls?.[0].result?.output).toBe('done')
    })
})
