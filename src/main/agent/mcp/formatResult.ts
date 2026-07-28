/**
 * MCP 工具调用结果格式化 — 共享工具函数
 *
 * 从 MCP 原始响应中提取 content（text parts）并标准化为 ToolResult 格式。
 * discovery.ts 和 mcpWorker.ts 共用此逻辑。
 */

import type {ToolResult} from '../tools/types'

/** 从 MCP 响应 content 数组中提取纯文本 */
function extractTextParts(result: any): string {
    return (result.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
}

/**
 * 将 MCP 原始调用结果标准化为 ToolResult 格式
 *
 * - 成功时：output 包含文本内容，error 为 undefined
 * - 失败时（isError=true）：output 为空字符串，error 包含错误信息
 *   注意：失败时不再把错误文本放在 output 中，避免 LLM 混淆
 */
export function formatMcpResult(result: any): Pick<ToolResult, 'success' | 'output' | 'error'> {
    const textParts = extractTextParts(result)
    return {
        success: !result.isError,
        output: result.isError ? '' : (textParts || '(无输出)'),
        error: result.isError ? textParts || 'MCP 工具执行失败' : undefined,
    }
}
