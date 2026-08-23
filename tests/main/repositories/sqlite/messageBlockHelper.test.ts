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

describe('块 id 统一规范（主进程去前缀 + 渲染侧 cb.id 直存）', () => {
    it('新路径块 id 不嵌套（直接采用渲染侧 cb.id）', () => {
        const msg: Message = {
            id: 'm1', role: 'assistant', content: '', timestamp: 1000,
            contentBlocks: [
                {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '思考', status: 'complete', timestamp: 1}},
                {id: 'text-m1-0', type: 'text', text: '正文'},
                {id: 'tool-tc1', type: 'tool_use', toolCall: {id: 'tc1', name: 'bash', arguments: {}, status: 'running', textOffset: 2}},
            ],
        }
        const {blocks} = messageToBlocks(msg, 'conv-1')
        expect(blocks.map(b => b.id)).toEqual(['think-m1-0', 'text-m1-0', 'm1-tc-tc1'])
        // 断言无嵌套：id 中不应出现 `${msg.id}-` 包裹其他 id 的形态
        expect(blocks.every(b => !b.id.includes('m1-text-m1') && !b.id.includes('m1-think-m1'))).toBe(true)
    })

    it('blocksToMessage 在新 id 规范下 round-trip 还原 contentBlocks', () => {
        const msg: Message = {
            id: 'm1', role: 'assistant', content: '', timestamp: 1000,
            contentBlocks: [
                {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '思考', status: 'complete', timestamp: 1}},
                {id: 'text-m1-0', type: 'text', text: '正文'},
            ],
        }
        const {messages: [record], blocks} = messageToBlocks(msg, 'conv-1')
        const restored = blocksToMessage(record, blocks)
        expect(restored.contentBlocks?.map(cb => cb.id)).toEqual(['think-m1-0', 'text-m1-0'])
    })

    it('工具前后两个不同 think id（think-m1-0 / think-m1-1）各产生独立块，不互相覆盖（回归保护）', () => {
        // 对应渲染侧 think id 段序号派生（Task 1）：同一消息两个 think 段 offset 相同但 id 不同，
        // 落库后两块都在（INSERT OR REPLACE 按 id 主键不再互相覆盖）
        const msg: Message = {
            id: 'm1', role: 'assistant', content: '', timestamp: 1000,
            contentBlocks: [
                {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '工具前思考', status: 'complete', timestamp: 1}},
                {id: 'text-m1-0', type: 'text', text: '正文'},
                {id: 'tool-tc1', type: 'tool_use', toolCall: {id: 'tc1', name: 'bash', arguments: {}, status: 'running', textOffset: 0}},
                {id: 'think-m1-1', type: 'think', thinkBlock: {id: 'think-m1-1', content: '工具后思考', status: 'complete', timestamp: 2}},
            ],
        }
        const {messages: [record], blocks} = messageToBlocks(msg, 'conv-1')
        const thinkBlocks = blocks.filter(b => b.blockType === 'think')
        expect(thinkBlocks.map(b => b.id).sort()).toEqual(['think-m1-0', 'think-m1-1'])
        expect(thinkBlocks.map(b => b.content).sort()).toEqual(['工具前思考', '工具后思考'])
        // 两块都能经 blocksToMessage 还原（不互相覆盖）
        const restored = blocksToMessage(record, blocks)
        const restoredThink = restored.contentBlocks?.filter(cb => cb.type === 'think')
        expect(restoredThink?.map(cb => cb.id).sort()).toEqual(['think-m1-0', 'think-m1-1'])
    })

    it('同一 think 段幂等 UPDATE 语义：同 id 单行后写内容 → blocksToMessage 仅一个块且为后写', () => {
        // think 段内多次 flush 不产生新块：同 id 的 INSERT OR REPLACE 是幂等更新。
        // 两次写入后 DB 中只有一行（后写内容），读回经 blocksToMessage 不得出现重复 think 块
        const msg: Message = {
            id: 'm1', role: 'assistant', content: '', timestamp: 1000,
            contentBlocks: [
                {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '思考1思考2', status: 'complete', timestamp: 3}},
            ],
        }
        const {messages: [record], blocks} = messageToBlocks(msg, 'conv-1')
        const thinkBlocks = blocks.filter(b => b.blockType === 'think')
        expect(thinkBlocks).toHaveLength(1)
        expect(thinkBlocks[0].id).toBe('think-m1-0')
        expect(thinkBlocks[0].content).toBe('思考1思考2')
        const restored = blocksToMessage(record, blocks)
        expect(restored.contentBlocks?.filter(cb => cb.type === 'think')).toHaveLength(1)
        expect(restored.contentBlocks?.find(cb => cb.type === 'think')).toMatchObject({
            id: 'think-m1-0',
        })
    })

    it('text 块 id 仍为 text-${msgId}-${offset}，不随 think id 改动受影响', () => {
        const msg: Message = {
            id: 'm1', role: 'assistant', content: '', timestamp: 1000,
            contentBlocks: [
                {id: 'think-m1-0', type: 'think', thinkBlock: {id: 'think-m1-0', content: '思考', status: 'complete', timestamp: 1}},
                {id: 'text-m1-5', type: 'text', text: '偏移5正文'},
            ],
        }
        const {messages: [record], blocks} = messageToBlocks(msg, 'conv-1')
        const textBlock = blocks.find(b => b.blockType === 'text')
        expect(textBlock?.id).toBe('text-m1-5')
        expect(textBlock?.content).toBe('偏移5正文')
        const restored = blocksToMessage(record, blocks)
        expect(restored.contentBlocks?.find(cb => cb.type === 'text')?.id).toBe('text-m1-5')
    })
})

describe('metadata 瘦身（Task 5：主进程 messageToBlocks 全量写路径与渲染端一致）', () => {
    it('assistant metadata 瘦身：不含 content/thinkBlock/toolCalls/contentBlocks', () => {
        const msg: Message = {
            id: 'm1', role: 'assistant', content: '正文', timestamp: 1000,
            thinkBlock: {id: 'think-m1-0', content: '思考', status: 'complete', timestamp: 1},
            toolCalls: [{id: 'tc1', name: 'bash', arguments: {}, status: 'success', textOffset: 0, result: {output: 'ok'}}],
            contentBlocks: [{id: 'text-m1-0', type: 'text', text: '正文'}],
            agentName: 'agent-a',
        }
        const {messages: [record]} = messageToBlocks(msg, 'conv-1')
        expect(record.metadata!.contentBlocks).toBeUndefined()
        expect(record.metadata!.thinkBlock).toBeUndefined()
        expect(record.metadata!.toolCalls).toBeUndefined()
        expect(record.metadata!.content).toBeUndefined()
        expect(record.metadata!.agentName).toBe('agent-a')
        // user/system 保留 content（buildMessagesFromRows:313 读回 metadata.content）
        const {messages: [userRecord]} = messageToBlocks(
            {id: 'u1', role: 'user', content: '你好', timestamp: 1} as Message,
            'conv-1',
        )
        expect(userRecord.metadata!.content).toBe('你好')
    })

    it('system 消息 metadata 同样保留 content', () => {
        const {messages: [record]} = messageToBlocks(
            {id: 's1', role: 'system', content: '系统提示', timestamp: 1} as Message,
            'conv-1',
        )
        expect(record.metadata!.content).toBe('系统提示')
        expect(record.content).toBe('系统提示')
    })
})
