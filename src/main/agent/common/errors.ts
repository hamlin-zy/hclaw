/**
 * 统一错误处理体系
 *
 * 将错误分为可重试和不可重试两类
 *
 * @deprecated 请使用 errorClassifier 模块获取更详细的错误分类
 */

import type {ClassifiedError, ErrorType, ErrorPattern} from './errorClassifier'
import {
    classifyErrorEnhanced,
    getRetryDelay as enhancedGetRetryDelay,
    createRetryableError,
    createPermanentError
} from './errorClassifier'

// 重新导出类型（供外部使用）
export {ErrorType, ClassifiedError, ErrorPattern}
export {classifyErrorEnhanced as classifyErrorNew, getRetryDelay as getRetryDelayNew}

// 重新导出错误类
export {createRetryableError, createPermanentError}

/** 可重试错误 */
export class RetryableError extends Error {
    constructor(
        message: string,
        public readonly cause?: Error,
        public readonly retryAfter?: number // 建议等待时间(ms)
    ) {
        super(message)
        this.name = 'RetryableError'
    }
}

/** 不可重试错误 */
export class PermanentError extends Error {
    constructor(
        message: string,
        public readonly code?: string,
        public readonly cause?: Error
    ) {
        super(message)
        this.name = 'PermanentError'
    }
}

/**
 * 分类错误类型
 *
 * @deprecated 请使用 classifyErrorEnhanced 获取更详细的错误信息
 */
export function classifyError(error: Error): 'retryable' | 'permanent' {
    const result = classifyErrorEnhanced(error)
    return result.retryable ? 'retryable' : 'permanent'
}

/**
 * 获取重试建议延迟
 *
 * @deprecated 请使用 classifyErrorEnhanced 获取更准确的延迟建议
 */
export function getRetryDelay(error: Error): number {
    return enhancedGetRetryDelay(error)
}
