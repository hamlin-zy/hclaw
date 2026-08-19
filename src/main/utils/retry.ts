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
