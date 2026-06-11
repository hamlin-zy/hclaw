/**
 * 意图分析 Prompt
 *
 * 用于分析用户请求的复杂度，决定使用哪个模型角色和 Agent 类型执行。
 */

import type {IntentAnalysisResult, ModelRole, TaskComplexity} from '@shared/types'

export const INTENT_ANALYSIS_SYSTEM_PROMPT = `你是一个任务分析器。分析用户的请求，评估任务复杂度。

## 复杂度判定标准

### simple（简单）
- 单次查询、简单读取
- 快速回答问题
- 预估 1-2 步完成
- 示例：「读取 package.json」「列出 src 目录」「什么是 React」

### moderate（中等）
- 常规开发任务
- 文件编辑、调试
- 多步骤但流程清晰
- 预估 3-10 步完成
- 示例：「添加一个按钮组件」「修复这个 bug」「重构这个函数」

### complex（复杂）
- 架构设计、重构
- 多文件修改
- 需要深度推理
- 预估 10+ 步完成
- 需要先制定计划
- 示例：「重构整个认证系统」「设计一个插件架构」「实现一个新功能模块」

## Agent 类型建议

根据任务性质选择最合适的 Agent 类型：

- **Explore**（探索）：只读搜索任务，如「探索代码结构」「查找某个函数」「分析这个模块」
- **Verification**（验证）：测试验证任务，如「验证这个功能」「测试登录流程」「检查代码质量」
- **General**（通用）：常规开发任务，如「实现功能」「修改代码」「添加组件」
- **Plan**（规划）：架构设计任务，如「设计系统架构」「制定重构计划」「规划模块拆分」

## 输出格式

直接输出 JSON，不要有任何其他内容：
{
  "summary": "用户想要...",
  "complexity": "simple" | "moderate" | "complex",
  "estimatedSteps": 数字,
  "needsPlanning": true | false,
  "suggestedModel": "lightweight" | "primary" | "reasoning",
  "suggestedAgentType": "Explore" | "Verification" | "General" | "Plan"
}

## 选择规则

### 模型选择
- simple → lightweight
- moderate → primary
- complex → reasoning

### Agent 类型选择
- 只读探索任务 → Explore
- 验证测试任务 → Verification
- 架构规划设计 → Plan
- 常规开发任务 → General
`

/**
 * 构建意图分析的用户消息
 */
export function buildIntentAnalysisMessage(userMessage: string, context?: {
    availableTools?: string[]
    conversationHistory?: number
}): string {
    let message = `分析以下用户请求：

"""
${userMessage}
"""
`

    if (context) {
        message += `\n上下文信息：
- 可用工具数量: ${context.availableTools?.length || 0}
- 对话历史消息数: ${context.conversationHistory || 0}
`
    }

    return message
}

/**
 * 解析意图分析结果
 */
export function parseIntentAnalysisResult(response: string): IntentAnalysisResult {
    try {
        // 尝试提取 JSON
        const jsonMatch = response.match(/\{[\s\S]*\}/)
        if (!jsonMatch) {
            throw new Error('No JSON found in response')
        }

        const parsed = JSON.parse(jsonMatch[0])

        // 验证必要字段
        const complexity = validateComplexity(parsed.complexity)
        const suggestedModel = validateModelRole(parsed.suggestedModel)
        const suggestedAgentType = validateAgentType(parsed.suggestedAgentType)

        return {
            summary: String(parsed.summary || '用户请求'),
            complexity,
            estimatedSteps: Math.max(1, Math.min(100, Number(parsed.estimatedSteps) || 5)),
            needsPlanning: Boolean(parsed.needsPlanning),
            suggestedModel,
            suggestedAgentType,
        }
    } catch (error) {
                // 返回默认值
        return {
            summary: '用户请求',
            complexity: 'moderate',
            estimatedSteps: 5,
            needsPlanning: false,
            suggestedModel: 'primary',
            suggestedAgentType: 'General',
        }
    }
}

function validateComplexity(value: unknown): TaskComplexity {
    if (value === 'simple' || value === 'moderate' || value === 'complex') {
        return value
    }
    return 'moderate'
}

function validateModelRole(value: unknown): ModelRole {
    if (value === 'lightweight' || value === 'primary' || value === 'reasoning') {
        return value
    }
    return 'primary'
}

function validateAgentType(value: unknown): string {
    if (typeof value === 'string' && value.trim()) {
        return value.trim()
    }
    return 'General'
}
