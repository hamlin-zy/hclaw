/**
 * GoogleAdapter convertMessages 单元测试
 *
 * 覆盖本次修复（方案 A）：
 * - system 角色消息（skill 工具的 injectMessage 完整指导）不再被丢弃
 * - 收集到 systemText，由 chat() 拼入 systemInstruction 送达 LLM
 * - 回归：history 结构、最后一条 user 消息分离、多模态/音频转换保持原行为
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {convertMessages} from '../../../../src/main/agent/model/googleAdapter'

function makeUserMsg(text: string): ChatMessage {
    return {role: 'user', content: text}
}

function makeAssistantMsg(text: string, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
    return {role: 'assistant', content: text, toolCalls}
}

function makeToolMsg(functionName: string, result: string): ChatMessage {
    return {role: 'tool', functionName, content: result, toolResult: result}
}

function makeSystemMsg(text: string): ChatMessage {
    return {role: 'system', content: text}
}

// ─── 核心修复：system 消息收集 ────────────────────────────

describe('convertMessages — system 消息收集（方案 A 修复）', () => {
    it('skill 工具的 injectMessage（system）被收集到 systemText，不再丢弃', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('请加载技能'),
            makeAssistantMsg('', [{id: 'tc1', name: 'skill', arguments: {skill: 'writing-plans'}}]),
            makeToolMsg('skill', '技能指导：...（前500字）...'),
            makeSystemMsg('# writing-plans\n\n## 技能指导\n\n完整指导内容'),
        ]

        const {history, systemText} = convertMessages(messages)

        expect(systemText).toContain('# writing-plans')
        expect(systemText).toContain('完整指导内容')
        // system 内容不混入 history
        expect(history.some(m => m.role === 'system')).toBe(false)
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
            {role: 'system', content: [{type: 'text', text: 'x'}] as any},
            makeUserMsg('hi'),
        ]
        const {systemText} = convertMessages(messages)
        expect(systemText).toBe('')
    })
})

// ─── 回归：Gemini 消息结构 ──────────────────────────────

describe('convertMessages — 回归行为', () => {
    it('最后一条 user 消息被分离到 lastUserMsg，其余进 history', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('q1'),
            makeAssistantMsg('a1'),
            makeUserMsg('q2'),
        ]

        const {history, lastUserMsg} = convertMessages(messages)

        expect(lastUserMsg).toEqual([{text: 'q2'}])
        expect(history).toEqual([
            {role: 'user', parts: [{text: 'q1'}]},
            {role: 'model', parts: [{text: 'a1'}]},
        ])
    })

    it('assistant 的 toolCalls 转为 functionCall parts', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('q'),
            makeAssistantMsg('', [{id: 'tc1', name: 'bash', arguments: {command: 'ls'}}]),
            makeUserMsg('q2'),
        ]

        const {history} = convertMessages(messages)

        const modelMsg = history.find(m => m.role === 'model')
        expect(modelMsg.parts).toEqual([
            {functionCall: {name: 'bash', args: {command: 'ls'}}},
        ])
    })

    it('tool 消息转为 functionResponse（使用 functionName）', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('q'),
            makeAssistantMsg('', [{id: 'tc1', name: 'bash', arguments: {command: 'ls'}}]),
            makeToolMsg('bash', 'file1\nfile2'),
            makeUserMsg('q2'),
        ]

        const {history} = convertMessages(messages)

        const fnMsg = history.find(m => m.role === 'function')
        expect(fnMsg.parts[0].functionResponse).toEqual({
            name: 'bash',
            response: {result: 'file1\nfile2'},
        })
    })

    it('context 角色消息转为 user 角色（Hook additionalContext）', () => {
        const messages: ChatMessage[] = [
            makeUserMsg('q'),
            {role: 'context', content: '背景信息'},
            makeUserMsg('q2'),
        ]

        const {history} = convertMessages(messages)

        expect(history.some(m => m.role === 'user' && m.parts.some((p: any) => p.text === '背景信息'))).toBe(true)
    })

    it('多模态 user 消息（图片 base64）转为 inlineData', () => {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: [
                    {type: 'text', text: '看图'},
                    {type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}},
                ],
            },
        ]

        const {lastUserMsg} = convertMessages(messages)

        expect(lastUserMsg).toEqual([
            {text: '看图'},
            {inlineData: {mimeType: 'image/png', data: 'aGVsbG8='}},
        ])
    })

    it('input_audio 部分转为 inlineData 音频', () => {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: [
                    {type: 'input_audio', input_audio: {format: 'mp3', data: 'AAAA'}},
                ],
            },
        ]

        const {lastUserMsg} = convertMessages(messages)

        expect(lastUserMsg).toEqual([
            {inlineData: {mimeType: 'audio/mpeg', data: 'AAAA'}},
        ])
    })
})

// ─── 图片块转换：URL 图修复（Task 10） ───────────────────────
// convertUserContent 为模块内部函数（未导出），沿用既有测试访问模式：
// 通过 convertMessages 的 lastUserMsg 获取转换结果

describe('convertUserContent — 图片块（URL 图修复）', () => {
    function imageMsg(url: string): ChatMessage {
        return {role: 'user', content: [{type: 'image_url', image_url: {url}}]}
    }

    it('网络 URL → fileData.fileUri（不再塞进 inlineData.data）', () => {
        const {lastUserMsg} = convertMessages([imageMsg('https://example.com/a.png')])
        expect(lastUserMsg[0]).toEqual({fileData: {mimeType: 'image/jpeg', fileUri: 'https://example.com/a.png'}})
    })

    it('base64 图回归：inlineData + mimeType（PNG）', () => {
        const {lastUserMsg} = convertMessages([imageMsg('data:image/png;base64,AAA')])
        expect(lastUserMsg[0]).toEqual({inlineData: {mimeType: 'image/png', data: 'AAA'}})
    })

    it('混合 [text, image_url, text] 顺序保持', () => {
        const {lastUserMsg} = convertMessages([{
            role: 'user',
            content: [
                {type: 'text', text: 'a'},
                {type: 'image_url', image_url: {url: 'data:image/gif;base64,R0lGOD'}},
                {type: 'text', text: 'b'},
            ],
        }])
        expect(lastUserMsg.map(p => Object.keys(p)[0])).toEqual(['text', 'inlineData', 'text'])
    })
})
