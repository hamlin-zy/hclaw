/**
 * 重试工具函数
 */

import type {StreamChunk} from '../agent/model/types'

/**
 * 延迟指定时间
 */
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** LLM调用超时时间（2分钟） */
export const LLM_TIMEOUT_MS = 600_000

/**
 * 超时错误
 */
export class TimeoutError extends Error {
    constructor(message: string = '请求超时') {
        super(message)
        this.name = 'TimeoutError'
    }
}

/**
 * 为 AsyncGenerator 添加超时控制
 * 超时后抛出 TimeoutError，不会自动重试
 */
export async function* withTimeout(
    stream: AsyncGenerator<StreamChunk>,
    timeoutMs: number = LLM_TIMEOUT_MS,
    abortSignal?: AbortSignal
): AsyncGenerator<StreamChunk> {
    const startTime = Date.now()

    // 创建一个标记是否超时的 Promise
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let timeoutRejected = false

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            timeoutRejected = true
            reject(new TimeoutError(`LLM 调用超时（${Math.round(timeoutMs / 1000)}秒）`))
        }, timeoutMs)
    })

    try {
        // 使用 Promise.race 来处理每次迭代
        const iterator = stream[Symbol.asyncIterator]()

        while (true) {
            if (abortSignal?.aborted) {
                yield {type: 'done', stopReason: 'end_turn'} as StreamChunk
                return
            }

            // 检查是否已超时
            if (timeoutRejected) {
                throw new TimeoutError(`LLM 调用超时（${Math.round(timeoutMs / 1000)}秒）`)
            }

            const result = await Promise.race([
                iterator.next(),
                timeoutPromise
            ])

            if (result.done) {
                return
            }

            // 重置超时计时器（每次收到数据后重置，避免长时间流式响应被误判超时）
            if (timeoutId) {
                clearTimeout(timeoutId)
                timeoutId = setTimeout(() => {
                    timeoutRejected = true
                }, timeoutMs)
            }

            yield result.value
        }
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
    }
}

/**
 * 简单的重试包装器 (针对普通 Promise)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        maxRetries: number
        initialDelay: number
        maxDelay: number
        onRetry?: (error: any, attempt: number, delay: number) => void
        shouldRetry?: (error: any) => boolean
    }
): Promise<T> {
    const {maxRetries, initialDelay, maxDelay, onRetry, shouldRetry} = options
    let lastError: any
    let currentDelay = initialDelay

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error: any) {
            lastError = error

            // 判断是否需要重 retry (默认针对 429 和 5xx 重试)
            const isRetryable = shouldRetry ? shouldRetry(error) : isCommonRetryableError(error)

            if (!isRetryable || attempt >= maxRetries) {
                throw error
            }

            if (onRetry) onRetry(error, attempt, currentDelay)

            await sleep(currentDelay)

            // 递增延迟 (指数退避，最大不超过 maxDelay)
            currentDelay = Math.min(currentDelay * 2, maxDelay)
        }
    }

    throw lastError
}

/**
 * 判断是否为常见的可重试错误 (429, 500, 502, 503, 504)
 */
function isCommonRetryableError(error: any): boolean {
    const status = error.status || error.statusCode || (error.response && error.response.status)
    const message = error.message || ''

    // 429 Too Many Requests
    if (status === 429) return true

    // 5xx Server Errors
    if (status >= 500 && status <= 599) return true

    // 某些 SDK 可能抛出的特定文本错误
    if (message.includes('rate limit') || message.includes('too many requests')) return true

    // 网络连接超时等
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') return true

    return false
}
