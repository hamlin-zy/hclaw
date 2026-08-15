/**
 * intentAnalyzer 单元测试
 *
 * 覆盖 analyzeIntent：
 * - 无用户消息 → 返回默认结果
 * - 正常流程：mock model.chat 流式返回分析 JSON → parseIntentAnalysisResult 解析正确
 * - 模型调用抛错（模拟超时/失败）→ 返回默认结果
 * - llmMetadata 结构（duration/inputTokens/outputTokens/inputContent/outputContent）
 * - 多模态 content（ContentPart[]）的纯文本提取
 *
 * Mock 策略：
 * - 被测模块仅依赖纯函数（buildIntentAnalysisMessage / parseIntentAnalysisResult /
 *   extractTextContent / withTimeout），无需额外 mock。
 * - model.chat 替换为手写 async generator，模拟流式 text / usage 块。
 */
import {describe, expect, it, vi} from 'vitest'
import type {ChatMessage, ModelAdapter, StreamChunk} from '@/main/agent/model/types'
import type {ContentPart} from '@/main/agent/model/types'

import {analyzeIntent, createDefaultResult} from '@/main/agent/model/intentAnalyzer'

// ─── 工具函数 ─────────────────────────────────────────────────

/** 构造一个 ModelAdapter stub，chat 返回给定流 */
function makeModel(chunks: StreamChunk[], chatImpl?: () => AsyncGenerator<StreamChunk>): ModelAdapter {
    const chat = chatImpl ?? (async function* () {
        for (const chunk of chunks) {
            yield chunk
        }
    })
    return {
        chat: vi.fn(chat) as unknown as ModelAdapter['chat'],
        getModelInfo: () => ({provider: 'test', model: 'test', maxContextTokens: 1000, supportsTools: false, supportsThinking: false}),
    }
}

/** 构造一条用户消息 */
function makeUserMessage(content: string | ContentPart[]): ChatMessage {
    return {id: 'u1', role: 'user', content}
}

/** 构造带意图分析的 JSON 响应流 */
function analysisStream(json: string, inputTokens = 100, outputTokens = 50): StreamChunk[] {
    return [
        {type: 'text', content: json},
        {type: 'usage', inputTokens, outputTokens},
    ]
}

// ─── analyzeIntent ─────────────────────────────────────────────

describe('analyzeIntent', () => {
    it('无用户消息 → 返回默认 result，无 llmMetadata', async () => {
        const model = makeModel([])
        const out = await analyzeIntent({
            messages: [{id: 'a1', role: 'assistant', content: '你好'}],
            model,
        })

        expect(out.result).toEqual(createDefaultResult('无用户消息'))
        expect(out.llmMetadata).toBeUndefined()
        expect(model.chat).not.toHaveBeenCalled()
    })

    it('正常流程：流式返回分析 JSON → result 解析正确', async () => {
        const json = JSON.stringify({
            summary: '重构认证模块',
            complexity: 'complex',
            estimatedSteps: 12,
            needsPlanning: true,
            suggestedModel: 'reasoning',
            suggestedAgentType: 'Plan',
        })
        const model = makeModel(analysisStream(json, 120, 40))
        const out = await analyzeIntent({
            messages: [makeUserMessage('请重构认证模块')],
            model,
        })

        expect(out.result).toEqual({
            summary: '重构认证模块',
            complexity: 'complex',
            estimatedSteps: 12,
            needsPlanning: true,
            suggestedModel: 'reasoning',
            suggestedAgentType: 'Plan',
        })
        // llmMetadata 结构
        expect(out.llmMetadata).toEqual({
            duration: expect.any(Number),
            inputTokens: 120,
            outputTokens: 40,
            inputContent: '请重构认证模块',
            outputContent: json,
        })
        // chat 被调用且带 maxTokens=500（分析任务限制）
        expect(model.chat).toHaveBeenCalledTimes(1)
        const params = vi.mocked(model.chat).mock.calls[0]![0]
        expect(params.maxTokens).toBe(500)
        expect(params.messages).toHaveLength(2)
        expect(params.messages[0]!.role).toBe('system')
        expect(params.messages[1]!.role).toBe('user')
    })

    it('模型调用抛错（模拟超时）→ 返回默认 result', async () => {
        const model = makeModel([], () => (async function* () {
            throw new Error('LLM 调用超时')
        })())
        const out = await analyzeIntent({
            messages: [makeUserMessage('修复这个 bug')],
            model,
        })

        expect(out.result).toEqual(createDefaultResult('修复这个 bug'))
        expect(out.llmMetadata).toBeUndefined()
    })

    it('模型响应解析失败 → 回退到 parseIntentAnalysisResult 的默认值', async () => {
        const model = makeModel(analysisStream('not-a-json'))
        const out = await analyzeIntent({
            messages: [makeUserMessage('列出文件')],
            model,
        })

        // parseIntentAnalysisResult 对非法 JSON 返回 moderate/primary/General 默认值
        expect(out.result).toEqual({
            summary: '用户请求',
            complexity: 'moderate',
            estimatedSteps: 5,
            needsPlanning: false,
            suggestedModel: 'primary',
            suggestedAgentType: 'General',
        })
        expect(out.llmMetadata?.outputContent).toBe('not-a-json')
    })

    it('多模态 content（ContentPart[]）→ 提取纯文本用于分析', async () => {
        const json = JSON.stringify({
            summary: '查看代码',
            complexity: 'simple',
            estimatedSteps: 2,
            needsPlanning: false,
            suggestedModel: 'lightweight',
            suggestedAgentType: 'Explore',
        })
        const model = makeModel(analysisStream(json))
        const out = await analyzeIntent({
            messages: [makeUserMessage([
                {type: 'text', text: '查看这段代码的结构'},
                {type: 'image_url', image_url: {url: 'data:image/png;base64,xxx'}},
            ])],
            model,
        })

        expect(out.result.suggestedModel).toBe('lightweight')
        expect(out.llmMetadata?.inputContent).toBe('查看这段代码的结构')
    })

    it('usage 块缺失 → inputTokens/outputTokens 默认为 0', async () => {
        const json = JSON.stringify({complexity: 'moderate'})
        const model = makeModel([{type: 'text', content: json}])
        const out = await analyzeIntent({
            messages: [makeUserMessage('你好')],
            model,
        })

        expect(out.llmMetadata?.inputTokens).toBe(0)
        expect(out.llmMetadata?.outputTokens).toBe(0)
        expect(out.result.complexity).toBe('moderate')
    })

    it('输出内容超长时被截断为 2000 字符', async () => {
        const longContent = 'x'.repeat(3000)
        const model = makeModel([{type: 'text', content: longContent}])
        const out = await analyzeIntent({
            messages: [makeUserMessage('你好')],
            model,
        })

        expect(out.llmMetadata?.outputContent).toHaveLength(2000)
        // 非 JSON 内容无法解析，走 parseIntentAnalysisResult 默认值
        expect(out.result.summary).toBe('用户请求')
    })
})
