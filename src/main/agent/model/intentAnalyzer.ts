/**
 * 意图分析器
 *
 * 使用主力模型分析用户意图，评估任务复杂度，决定后续执行策略。
 */

import type {ChatMessage, ContentPart, ModelAdapter, StreamChunk} from './types'
import type {HClawAgentType, IntentAnalysisResult, ModelRole, TaskComplexity} from '@shared/types'
import {
    buildIntentAnalysisMessage,
    INTENT_ANALYSIS_SYSTEM_PROMPT,
    parseIntentAnalysisResult,
} from '../prompts/intentAnalysis'
import {LLM_TIMEOUT_MS, withTimeout} from '../../utils/retry'
import {extractTextContent} from '../utils/contentUtils'

export interface IntentAnalysisParams {
    messages: ChatMessage[]
    model: ModelAdapter
    availableTools?: string[]
}

/**
 * 分析用户意图
 *
 * 使用主力模型进行意图分析，返回复杂度评估和执行建议。
 */
export async function analyzeIntent(
    params: IntentAnalysisParams,
): Promise<{
    result: IntentAnalysisResult;
    llmMetadata?: {
        duration: number;
        inputTokens: number;
        outputTokens: number;
        inputContent: string;
        outputContent: string
    }
}> {
    const {messages, model, availableTools} = params

    // 获取最后一条用户消息
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMessage) {
        return {result: createDefaultResult('无用户消息')}
    }

    // 提取纯文本内容
    const textContent = extractTextContent(lastUserMessage.content)

    // 构建分析请求
    const analysisMessages: ChatMessage[] = [
        {
            role: 'system',
            content: INTENT_ANALYSIS_SYSTEM_PROMPT,
        },
        {
            role: 'user',
            content: buildIntentAnalysisMessage(textContent, {
                availableTools,
                conversationHistory: messages.length,
            }),
        },
    ]

    try {
        // 调用模型（非流式，只需要结果）
        const response = await callModelForAnalysis(model, analysisMessages)
        const result = parseIntentAnalysisResult(response.content)

        return {
            result,
            llmMetadata: {
                duration: response.duration,
                inputTokens: response.inputTokens,
                outputTokens: response.outputTokens,
                inputContent: textContent.slice(0, 500),
                outputContent: response.content.slice(0, 2000),
            },
        }
    } catch (error) {
        return {result: createDefaultResult(textContent)}
    }
}

/**
 * 调用模型进行分析（收集完整响应，带超时控制）
 */
async function callModelForAnalysis(
    model: ModelAdapter,
    messages: ChatMessage[],
): Promise<{ content: string; duration: number; inputTokens: number; outputTokens: number }> {
    const startTime = Date.now()
    const chunks: StreamChunk[] = []
    let inputTokens = 0
    let outputTokens = 0

    // 创建流并使用 withTimeout 包装（2分钟超时）
    const rawStream = model.chat({
        messages,
        maxTokens: 500, // 分析任务不需要太长响应
    })
    const stream = withTimeout(rawStream, LLM_TIMEOUT_MS)

    for await (const chunk of stream) {
        chunks.push(chunk)
        if (chunk.type === 'usage') {
            inputTokens = (chunk as { type: 'usage'; inputTokens: number; outputTokens: number }).inputTokens
            outputTokens = (chunk as { type: 'usage'; inputTokens: number; outputTokens: number }).outputTokens
        }
    }

    const elapsed = Date.now() - startTime

    // 提取文本内容
    const textParts = chunks
        .filter((c) => c.type === 'text')
        .map((c) => (c as { type: 'text'; content: string }).content)

    return {
        content: textParts.join(''),
        duration: elapsed,
        inputTokens,
        outputTokens,
    }
}

/**
 * 创建默认分析结果（基于启发式规则）
 */
export function createDefaultResult(userMessage: string | ContentPart[]): IntentAnalysisResult {
    // 提取纯文本
    const textContent = typeof userMessage === 'string'
        ? userMessage
        : userMessage.filter(p => p.type === 'text').map(p => p.text).join(' ')

    const msg = textContent.toLowerCase()
    const messageLength = textContent.length

    // 1. 识别任务类型关键词
    const isComplex = /重构|架构|设计|实现|优化|迁移|升级|refactor|architect|implement|optimize|migrate|upgrade|fix/i.test(msg)
    const isRead = /读取|查看|列出|搜索|查找|查找代码|read|list|search|find|grep|what|how|where/i.test(msg)
    const isWrite = /创建|修改|写入|添加|更新|create|write|modify|add|update|edit/i.test(msg)
    const isExplore = /探索|分析|理解|结构|关系|代码逻辑|explore|analyze|understand|structure|logic|how does/i.test(msg)
    const isTest = /验证|测试|检查|调试|verify|test|check|debug|broken|fail/i.test(msg)

    let complexity: TaskComplexity = 'moderate'
    let suggestedModel: ModelRole = 'primary'
    let suggestedAgentType: HClawAgentType = 'General'

    // 2. 启发式决策矩阵
    if (isComplex || messageLength > 400) {
        complexity = 'complex'
        suggestedModel = 'reasoning'
        suggestedAgentType = 'Plan'
    } else if (isRead && !isWrite && messageLength < 150) {
        complexity = 'simple'
        suggestedModel = 'lightweight'
        suggestedAgentType = 'Explore'
    } else if (isExplore) {
        complexity = 'moderate'
        suggestedModel = 'lightweight' // 探索类任务可以用轻量模型先行
        suggestedAgentType = 'Explore'
    } else if (isTest) {
        complexity = 'moderate'
        suggestedModel = 'primary'
        suggestedAgentType = 'Verification'
    }

    // 3. 预估步骤
    const estimatedSteps = complexity === 'simple' ? 2 : complexity === 'complex' ? 12 : 5

    return {
        summary: textContent.slice(0, 100),
        complexity,
        estimatedSteps,
        needsPlanning: complexity === 'complex',
        suggestedModel,
        suggestedAgentType,
    }
}

/**
 * 快速复杂度评估（不调用 LLM，仅用启发式规则）
 *
 * 用于某些场景下的快速判断，避免额外的 LLM 调用。
 */
export function quickComplexityCheck(userMessage: string): IntentAnalysisResult {
    return createDefaultResult(userMessage)
}
