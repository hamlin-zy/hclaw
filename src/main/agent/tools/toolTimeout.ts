/**
 * 工具超时处理工具
 *
 * 为工具执行添加超时保护，防止工具调用卡住。
 */

import type {ToolResult} from './types'

/**
 * 超时错误类
 */
export class ToolTimeoutError extends Error {
    toolName: string
    timeoutMs: number

    constructor(toolName: string, timeoutMs: number) {
        super(`工具 "${toolName}" 执行超时（${Math.round(timeoutMs / 1000)}秒）`)
        this.name = 'ToolTimeoutError'
        this.toolName = toolName
        this.timeoutMs = timeoutMs
    }
}

/**
 * 带超时的工具执行包装器
 * @param promise 工具执行 Promise
 * @param toolName 工具名称（用于错误信息）
 * @param timeoutMs 超时时间（毫秒）
 * @returns 工具执行结果，超时则返回超时错误
 */
export async function withToolTimeout<T = any>(
    promise: Promise<ToolResult<T>>,
    toolName: string,
    timeoutMs: number,
): Promise<ToolResult<T>> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const timeoutPromise = new Promise<ToolResult<T>>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new ToolTimeoutError(toolName, timeoutMs))
        }, timeoutMs)
    })

    try {
        const result = await Promise.race([promise, timeoutPromise])
        return result
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
    }
}

/**
 * 从错误创建超时结果
 */
export function createTimeoutResult(toolName: string, timeoutMs: number): ToolResult<string> {
    const message = `工具 "${toolName}" 执行超时（${Math.round(timeoutMs / 1000)}秒）。` +
        `\n这可能是由于网络问题、外部服务无响应或操作耗时过长导致的。` +
        `\n您可以尝试：\n` +
        `1. 检查网络连接\n` +
        `2. 重试操作\n` +
        `3. 增加工具超时时间（在设置中配置）`
    return {
        success: false,
        output: message,
        error: message
    }
}
