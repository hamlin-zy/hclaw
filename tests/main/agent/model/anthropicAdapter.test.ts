/**
 * AnthropicAdapter convertMessages 单元测试
 *
 * 覆盖 R4 修复：
 * - system 角色消息（skill 工具的 injectMessage 完整指导）原位保留为 user text block，
 *   不再提升为 system 参数第三块（提升会破坏前缀缓存命中）
 * - 不打断 tool_use/tool_result 配对（injectMessage 追加在 tool 消息之后）
 * - 回归：普通消息转换、多模态内容、thinking 块回传保持原行为
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {convertMessages} from '../../../../src/main/agent/model/anthropicAdapter'

function makeUserMsg(text: string): ChatMessage {
    return {role: 'user', content: text}
}

function makeAssistantMsg(text: string, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
    return {role: 'assistant', content: text, toolCalls}
}

function makeToolMsg(toolCallId: string, result: string): ChatMessage {
    return {role: 'tool', toolCallId, content: result, toolResult: result}
}

function makeSystemMsg(text: string): ChatMessage {
    return {role: 'system', content: text}
}

// ─── R4：注入 system 消息原位保留 ────────────────────────

describe('convertMessages — 注入 system 消息原位保留（R4）', () => {
    it('skill 工具的 injectMessage（system）原位转为 user text block，不提升为 system 块', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('请加载 writing-plans 技能'),
            makeAssistantMsg('', [{id: 'tc1', name: 'skill', arguments: {skill: 'writing-plans'}}]),
            makeToolMsg('tc1', '技能指导：## Overview ...（前500字）...'),
            makeSystemMsg('# writing-plans\n\n## 技能指导\n\n## Overview\n...完整指导内容...'),
        ]

        const {apiMessages} = convertMessages(messages)

        // 注入文本出现在消息序列末尾的 user 消息中
        const last = apiMessages[apiMessages.length - 1]
        expect(last.role).toBe('user')
        const blocks = last.content as Array<{type: string; text?: string; tool_use_id?: string}>
        expect(blocks.some(b => b.type === 'text' && b.text!.includes('完整指导内容'))).toBe(true)
        // 且与 tool_result 合并进同一条 user 消息（原位、不产生连续独立注入块）
        expect(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === 'tc1')).toBe(true)
    })

    it('多条 system 消息各自在原位置输出为 user text block', () => {
        const messages: ChatMessage[] = [
            makeSystemMsg('第一段'),
            makeUserMsg('hi'),
            makeSystemMsg('第二段'),
        ]

        const {apiMessages} = convertMessages(messages)
        expect(apiMessages).toEqual([
            {role: 'user', content: [{type: 'text', text: '第一段'}]},
            {role: 'user', content: [{type: 'text', text: 'hi'}, {type: 'text', text: '第二段'}]},
        ])
    })

    it('system 消息 content 非字符串时安全降级为空（不产出空 user 消息）', () => {
        const messages: ChatMessage[] = [
            {role: 'system', content: [{type: 'text', text: '不应出现'}] as any},
            makeUserMsg('hi'),
        ]
        const {apiMessages} = convertMessages(messages)
        expect(apiMessages).toEqual([{role: 'user', content: [{type: 'text', text: 'hi'}]}])
    })

    it('无 system 消息时输出不含注入块', () => {
        const messages: ChatMessage[] = [makeUserMsg('hi')]
        const {apiMessages} = convertMessages(messages)
        expect(apiMessages).toEqual([{role: 'user', content: [{type: 'text', text: 'hi'}]}])
    })
})

// ─── 回归：普通消息转换 ──────────────────────────────────

describe('convertMessages — 回归行为', () => {
    it('普通 user/assistant 消息转换不受影响', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('hello'),
            makeAssistantMsg('hi there'),
            makeUserMsg('again'),
        ]

        const {apiMessages} = convertMessages(messages)

        expect(apiMessages).toEqual([
            {role: 'user', content: [{type: 'text', text: 'hello'}]},
            {role: 'assistant', content: 'hi there'},
            {role: 'user', content: [{type: 'text', text: 'again'}]},
        ])
    })

    it('带 thinking 的 assistant 消息保留 thinking 块回传', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('q'),
            {
                role: 'assistant',
                content: 'answer',
                thinking: '思考过程',
                thinkingSignature: 'sig-123',
            },
        ]

        const {apiMessages} = convertMessages(messages, true)

        const assistantMsg = apiMessages.find(m => m.role === 'assistant')
        const blocks = assistantMsg!.content as Array<{type: string; thinking?: string; signature?: string; text?: string}>
        expect(blocks.some(b => b.type === 'thinking' && b.thinking === '思考过程' && b.signature === 'sig-123')).toBe(true)
        expect(blocks.some(b => b.type === 'text' && b.text === 'answer')).toBe(true)
    })

    it('多模态 user 消息（图片）转换不受影响', () => {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: [
                    {type: 'text', text: '看图'},
                    {type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}},
                ],
            },
        ]

        const {apiMessages} = convertMessages(messages)

        const blocks = apiMessages[0].content as Array<{type: string; text?: string; source?: {type: string; media_type: string}}>
        expect(blocks[0]).toMatchObject({type: 'text', text: '看图'})
        expect(blocks[1]).toMatchObject({
            type: 'image',
            source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='},
        })
    })

    it('无对应 tool_result 的 tool_use 被跳过（不产生孤立 tool_use）', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('q'),
            makeAssistantMsg('', [{id: 'orphan', name: 'bash', arguments: {command: 'ls'}}]),
        ]

        const {apiMessages} = convertMessages(messages)

        // assistant 无文本/无 thinking 且 tool_use 全被跳过 → 不产生 assistant 消息
        const assistantMsgs = apiMessages.filter(m => m.role === 'assistant')
        expect(assistantMsgs).toHaveLength(0)
    })
})

import {convertUserContent} from '../../../../src/main/agent/model/anthropicAdapter'

describe('convertUserContent — 图片块（URL 图修复）', () => {
  it('网络 URL → source.type=url（不再塞进 base64.data）', () => {
    const blocks = convertUserContent([
      {type: 'image_url', image_url: {url: 'https://example.com/a.png'}},
    ])
    expect(blocks[0]).toEqual({
      type: 'image',
      source: {type: 'url', url: 'https://example.com/a.png'},
    })
  })

  it('base64 图回归：source.type=base64 + media_type + data', () => {
    const blocks = convertUserContent([
      {type: 'image_url', image_url: {url: 'data:image/gif;base64,R0lGOD'}},
    ])
    expect((blocks[0] as any).source.type).toBe('base64')
    expect((blocks[0] as any).source.media_type).toBe('image/gif')
    expect((blocks[0] as any).source.data).toBe('R0lGOD')
  })

  it('混合 [text, image_url, text] 顺序保持', () => {
    const blocks = convertUserContent([
      {type: 'text', text: 'a'},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
      {type: 'text', text: 'b'},
    ])
    expect(blocks.map(b => b.type)).toEqual(['text', 'image', 'text'])
  })

  it('data URI 非法 base64（无分隔符）→ 不抛异常', () => {
    const blocks = convertUserContent([
      {type: 'image_url', image_url: {url: 'data:image/png;base64'}},
    ])
    expect(blocks[0].type).toBe('image')
    expect((blocks[0] as any).source.type).toBe('base64')
  })
})
