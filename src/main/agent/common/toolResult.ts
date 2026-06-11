/**
 * 工具结果联合类型
 *
 * 替代现有的 success/error 混合格式
 */

export type ToolResult =
    | ToolSuccessResult
    | ToolErrorResult

export interface ToolSuccessResult {
    success: true
    output: string | object
    metadata?: {
        duration?: number
        tokens?: { input: number; output: number }
    }
}

export interface ToolErrorResult {
    success: false
    output: null
    error: string
    code?: string
    originalError?: Error
}

// 工厂函数
export function successResult(output: string | object, metadata?: ToolSuccessResult['metadata']): ToolSuccessResult {
    return { success: true, output, metadata }
}

export function errorResult(error: string | Error, code?: string): ToolErrorResult {
    const message = error instanceof Error ? error.message : error
    return {
        success: false,
        output: null,
        error: message,
        code,
        originalError: error instanceof Error ? error : undefined,
    }
}
