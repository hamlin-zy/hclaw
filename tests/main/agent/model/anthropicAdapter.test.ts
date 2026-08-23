/**
 * AnthropicAdapter convertMessages 单元测试
 *
 * 覆盖本次修复（方案 A）：
 * - system 角色消息（skill 工具的 injectMessage 完整指导）不再被丢弃
 * - 收集到 systemText，由 chat() 通过 system 参数送达 LLM
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

// ─── 核心修复：system 消息收集 ────────────────────────────

describe('convertMessages — system 消息收集（方案 A 修复）', () => {
    it('skill 工具的 injectMessage（system）被收集到 systemText，不再丢弃', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('请加载 writing-plans 技能'),
            makeAssistantMsg('', [{id: 'tc1', name: 'skill', arguments: {skill: 'writing-plans'}}]),
            makeToolMsg('tc1', '技能指导：## Overview ...（前500字）...'),
            makeSystemMsg('# writing-plans\n\n## 技能指导\n\n## Overview\n...完整指导内容...'),
        ]

        const {apiMessages, systemText} = convertMessages(messages)

        // system 消息被收集
        expect(systemText).toContain('# writing-plans')
        expect(systemText).toContain('完整指导内容')
        // 且不混入 apiMessages
        expect(apiMessages.some(m => (m as any).role === 'system')).toBe(false)
    })

    it('多条 system 消息按顺序拼接（\n\n 分隔）', () => {
        const messages: ChatMessage[] = [
            makeSystemMsg('第一段'),
            makeUserMsg('hi'),
            makeSystemMsg('第二段'),
        ]

        const {systemText} = convertMessages(messages)
        expect(systemText).toBe('第一段\n\n第二段')
    })

    it('无 system 消息时 systemText 为空串', () => {
        const messages: ChatMessage[] = [makeUserMsg('hi')]
        const {systemText} = convertMessages(messages)
        expect(systemText).toBe('')
    })

    it('system 消息 content 非字符串时安全降级为空', () => {
        const messages: ChatMessage[] = [
            {role: 'system', content: [{type: 'text', text: '不应出现'}] as any},
            makeUserMsg('hi'),
        ]
        const {systemText} = convertMessages(messages)
        expect(systemText).toBe('')
    })

    it('injectMessage 追加在 tool 消息之后时不破坏 tool_use/tool_result 配对', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('q1'),
            makeAssistantMsg('', [{id: 'tc1', name: 'skill', arguments: {skill: 'x'}}]),
            makeToolMsg('tc1', 'preview'),
            makeSystemMsg('完整指导'),
        ]

        const {apiMessages, systemText} = convertMessages(messages)

        // tool_result 正常合并进单条 user 消息（含 tool_result 块的 user 消息）
        const toolResultMsg = apiMessages.find(m =>
            m.role === 'user' &&
            Array.isArray(m.content) &&
            (m.content as Array<{type: string}>).some(b => b.type === 'tool_result'),
        )
        expect(toolResultMsg).toBeDefined()
        const blocks = toolResultMsg!.content as Array<{type: string; tool_use_id?: string}>
        expect(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === 'tc1')).toBe(true)

        // system 内容在 systemText 中，不在 apiMessages 里
        expect(systemText).toBe('完整指导')
        expect(apiMessages.some(m => (m as any).role === 'system')).toBe(false)
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

        const {apiMessages, systemText} = convertMessages(messages)

        expect(apiMessages).toEqual([
            {role: 'user', content: [{type: 'text', text: 'hello'}]},
            {role: 'assistant', content: 'hi there'},
            {role: 'user', content: [{type: 'text', text: 'again'}]},
        ])
        expect(systemText).toBe('')
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