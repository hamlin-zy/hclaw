import {describe, expect, it} from 'vitest'
import {blocksToMessage, messageToBlocks} from '@/main/repositories/sqlite/messageBlockHelper'
import type {ContentBlock, Message, MessageBlock} from '@shared/types'

describe('messageToBlocks — turnIndex 持久化（方案 2）', () => {
    it('contentBlocks 带 turnIndex 时写入块', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            contentBlocks: [
                {id: 'cb-think-1', type: 'think', turnIndex: 0, thinkBlock: {id: 'think-1', content: '思考', status: 'complete', timestamp: 1000}},
                {id: 'cb-text-1', type: 'text', turnIndex: 0, text: '正文'},
                {id: 'cb-tool-1', type: 'tool_use', turnIndex: 1, toolCall: {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}, status: 'success', result: {output: 'ok'}}},
            ] as ContentBlock[],
        }
        const {blocks} = messageToBlocks(msg, 'conv-root')
        const thinkBlock = blocks.find(b => b.blockType === 'think')!
        const textBlock = blocks.find(b => b.blockType === 'text')!
        const tcBlock = blocks.find(b => b.blockType === 'tool_call')!
        expect(thinkBlock.turnIndex).toBe(0)
        expect(textBlock.turnIndex).toBe(0)
        expect(tcBlock.turnIndex).toBe(1)
    })

    it('contentBlocks 无 turnIndex 时块 turnIndex 为 undefined（兼容）', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 1000,
            contentBlocks: [
                {id: 'cb-think-1', type: 'think', thinkBlock: {id: 'think-1', content: '思考', status: 'complete', timestamp: 1000}},
                {id: 'cb-text-1', type: 'text', text: '正文'},
            ] as ContentBlock[],
        }
        const {blocks} = messageToBlocks(msg, 'conv-root')
        expect(blocks.every(b => b.turnIndex === undefined)).toBe(true)
    })

    it('扁平字段路径（无 contentBlocks）turnIndex 为 undefined', () => {
        const msg: Message = {
            id: 'm1',
            role: 'assistant',
            content: '正文',
            timestamp: 1000,
            toolCalls: [{id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}],
        }
        const {blocks} = messageToBlocks(msg, 'conv-root')
        expect(blocks.every(b => b.turnIndex === undefined)).toBe(true)
    })
})

describe('blocksToMessage — turnIndex 透传到 ContentBlock（方案 2）', () => {
    function block(id: string, blockType: MessageBlock['blockType'], seq: number, turnIndex?: number, data?: string, content?: string | null): MessageBlock {
        return {
            id, messageId: 'm1', blockType, content: content ?? null, data: data ?? null,
            sequence: seq, timestamp: 1000, ...(turnIndex !== undefined ? {turnIndex} : {}),
        }
    }

    it('think/text/tool_use 块透传 turnIndex', () => {
        const record: Message = {id: 'm1', role: 'assistant', content: '', timestamp: 1000}
        const blocks: MessageBlock[] = [
            block('think-1', 'think', 0, 0, JSON.stringify({id: 'think-1', content: '思考', status: 'complete', timestamp: 1000})),
            block('text-1', 'text', 1, 0, undefined, '正文'),
            block('tc-1', 'tool_call', 2, 1, JSON.stringify({id: 'tc-1', name: 'bash', arguments: {command: 'ls'}, status: 'running'})),
            block('tr-1', 'tool_result', 3, 1, JSON.stringify({id: 'tc-1', result: {output: 'ok'}})),
        ]
        const restored = blocksToMessage(record, blocks)
        const cbs = restored.contentBlocks!
        expect(cbs.find(cb => cb.type === 'think')!.turnIndex).toBe(0)
        expect(cbs.find(cb => cb.type === 'text')!.turnIndex).toBe(0)
        const toolCb = cbs.find(cb => cb.type === 'tool_use')!
        expect(toolCb.turnIndex).toBe(1)
        expect(toolCb.toolCall!.result).toEqual({output: 'ok'})
    })

    it('无 turnIndex 的块（旧数据）ContentBlock.turnIndex 为 undefined', () => {
        const record: Message = {id: 'm1', role: 'assistant', content: '', timestamp: 1000}
        const blocks: MessageBlock[] = [
            block('think-1', 'think', 0, undefined, JSON.stringify({id: 'think-1', content: '思考', status: 'complete', timestamp: 1000})),
        ]
        const restored = blocksToMessage(record, blocks)
        expect(restored.contentBlocks![0].turnIndex).toBeUndefined()
    })
})
