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

    it('tool_call block 序列化 timeoutMs（一次性运行时信息，不持久化）', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            toolCalls: [{
                id: 'tc-4',
                name: 'file_read',
                arguments: {},
                status: 'running',
                timeoutMs: 60000,
            }],
        }
        const {blocks} = messageToBlocks(msg, 'conv-root')
        const tcBlock = blocks.find(b => b.blockType === 'tool_call')
        const data = JSON.parse(tcBlock!.data!)
        // 超时时间只在运行时（tool_start 事件）使用，用完即弃，不落入持久化
        expect(data.timeoutMs).toBeUndefined()
    })
})

describe('用户命令上下文透传（/能力 徽章持久化链路）', () => {
    it('user 消息 metadata 保留 commandId / commandArgs / commandTemplate', () => {
        const msg = {
            id: 'u1',
            role: 'user' as const,
            content: '/brainstorming\n我想设计一个功能',
            timestamp: 1000,
            metadata: {
                commandId: 'skill:brainstorming',
                commandArgs: '我想设计一个功能',
                commandTemplate: '请使用 brainstorming 技能：$ARGUMENTS',
            },
        } as Message
        const {messages: [record]} = messageToBlocks(msg, 'conv-root')
        expect(record.metadata?.commandId).toBe('skill:brainstorming')
        expect(record.metadata?.commandArgs).toBe('我想设计一个功能')
        expect(record.metadata?.commandTemplate).toBe('请使用 brainstorming 技能：$ARGUMENTS')
    })

    it('commandId 在顶层时也透传（DB 加载后 metadata 展开的兼容路径）', () => {
        const msg = {
            id: 'u2',
            role: 'user' as const,
            content: '/agent-name 帮我分析',
            timestamp: 1000,
            commandId: 'agent:agent-name',
        } as Message
        const {messages: [record]} = messageToBlocks(msg, 'conv-root')
        expect(record.metadata?.commandId).toBe('agent:agent-name')
    })

    it('无命令上下文的消息不引入脏字段（回归）', () => {
        const msg = {
            id: 'u3',
            role: 'user' as const,
            content: '普通消息',
            timestamp: 1000,
        } as Message
        const {messages: [record]} = messageToBlocks(msg, 'conv-root')
        expect(record.metadata?.commandId).toBeUndefined()
        expect(record.metadata?.commandArgs).toBeUndefined()
    })
})
