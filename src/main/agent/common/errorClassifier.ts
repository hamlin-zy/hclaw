/**
 * 错误分类模式库
 *
 * 提供细粒度的错误类型识别，包括：
 * - RateLimit: 限流错误
 * - Auth: 认证/授权错误
 * - Timeout: 超时错误
 * - Network: 网络连接错误
 * - QuotaExceeded: 配额超限错误
 * - ServerError: 服务器错误
 * - Unknown: 未知错误
 */

import {logger} from '../logger'

// ============================================
// 类型定义
// ============================================

/** 错误类型枚举 */
export enum ErrorType {
    RateLimit = 'RATE_LIMIT',
    Auth = 'AUTH',
    Timeout = 'TIMEOUT',
    Network = 'NETWORK',
    QuotaExceeded = 'QUOTA_EXCEEDED',
    ServerError = 'SERVER_ERROR',
    Unknown = 'UNKNOWN'
}

/** 错误分类结果 */
export interface ClassifiedError {
    type: ErrorType
    retryable: boolean
    retryAfter?: number // 建议等待时间(ms)
    originalError: Error
}

/** 错误模式匹配器 */
export interface ErrorPattern {
    type: ErrorType
    test: (error: Error) => boolean
    retryable: boolean
    retryAfter?: number
}

// ============================================
// 辅助函数
// ============================================

/**
 * 提取错误消息（包含 cause 链）
 */
function extractErrorMessage(error: Error): string {
    let message = error.message
    let current: any = error

    // 遍历 cause 链
    while (current.cause && current.cause !== current) {
        current = current.cause
        if (current.message) {
            message += `; ${current.message}`
        }
    }

    return message
}

/**
 * 获取 HTTP 状态码
 */
function getHttpStatus(error: any): number | undefined {
    return error.status || error.statusCode ||
        (error.response?.status) ||
        (error.response?.statusCode)
}

/**
 * 获取错误码
 */
function getErrorCode(error: any): string | undefined {
    return error.code ||
        error.errorCode ||
        (error.response?.data?.error?.code) ||
        (error.response?.code)
}

/**
 * 获取错误类型标识
 */
function getErrorType(error: any): string | undefined {
    return error.type ||
        error.errorType ||
        error.name ||
        (error.response?.data?.error?.type) ||
        (error.response?.type)
}

// ============================================
// 模式定义
// ============================================

/**
 * RateLimit 模式匹配
 * - HTTP 429
 * - 消息包含 rate_limit, too_many_requests, rate.limit
 */
const rateLimitPatterns: Array<{test: (msg: string, err: any) => boolean; retryAfter: number}> = [
    {test: (msg) => /\brate.limit\b/i.test(msg) || /\brate_limit\b/i.test(msg), retryAfter: 60_000},
    {test: (msg) => /\btoo.many.requests?\b/i.test(msg), retryAfter: 60_000},
    {test: (msg) => /\bthrottl(e|ing)\b/i.test(msg), retryAfter: 30_000},
    {test: (msg) => /\bover.rate\b/i.test(msg), retryAfter: 60_000},
]

/**
 * Auth 模式匹配
 * - HTTP 401/403
 * - 消息包含 invalid_api_key, unauthorized, auth.*fail
 */
const authPatterns: Array<{test: (msg: string, err: any) => boolean}> = [
    {test: (msg) => /\binvalid.api.key\b/i.test(msg)},
    {test: (msg) => /\bunauthorized\b/i.test(msg)},
    {test: (msg) => /\bauth.*fail(ed)?\b/i.test(msg)},
    {test: (msg) => /\binvalid\s+(access\s+)?token\b/i.test(msg)},
    {test: (msg) => /\b(token\s+)?expired\b/i.test(msg)},  // 匹配 "Token has expired" 和 "expired token"
    {test: (msg) => /\bmissing.auth\b/i.test(msg)},
    {test: (msg) => /\bincorrect.api.key\b/i.test(msg)},
]

/**
 * Timeout 模式匹配
 * - 消息包含 timeout, timed.out
 * - 排除 gateway timeout（这是 ServerError）
 * - 注意：错误码(ETIMEDOUT/ESOCKETTIMEDOUT)检查在 classifyByErrorCode 中完成
 */
const timeoutPatterns: Array<{test: (msg: string) => boolean; retryAfter: number}> = [
    {test: (msg) => /\btimeout\b/i.test(msg) && !/\b(gateway|connection|server).timeout\b/i.test(msg), retryAfter: 5_000},
]

/**
 * Network 模式匹配
 * - Node.js 错误码: ENOTFOUND, ECONNREFUSED, ECONNRESET, EAI_AGAIN
 */
const networkPatterns: Array<{test: (msg: string, code: string | undefined) => boolean; retryAfter: number}> = [
    {test: (msg, code) => code === 'ENOTFOUND', retryAfter: 5_000},
    {test: (msg, code) => code === 'ECONNREFUSED', retryAfter: 3_000},
    {test: (msg, code) => code === 'ECONNRESET', retryAfter: 5_000},
    {test: (msg, code) => code === 'EAI_AGAIN', retryAfter: 5_000},
    {test: (msg) => /\bconnection.refused\b/i.test(msg), retryAfter: 3_000},
    {test: (msg) => /\bconnection.reset\b/i.test(msg), retryAfter: 5_000},
    {test: (msg) => /\bnetwork.error\b/i.test(msg), retryAfter: 5_000},
]

/**
 * QuotaExceeded 模式匹配
 * - 消息包含 quota_exceeded, monthly_limit, daily_limit
 */
const quotaPatterns: Array<{test: (msg: string) => boolean; retryAfter: number}> = [
    {test: (msg) => /\bquota.exceeded\b/i.test(msg), retryAfter: 3600_000}, // 1 hour
    {test: (msg) => /\bmonthly\s+(api\s+)?(limit|quota)\b/i.test(msg), retryAfter: 86400_000}, // 1 day
    {test: (msg) => /\bdaily\s+(request\s+)?limit\b/i.test(msg), retryAfter: 86400_000},   // 1 day
    {test: (msg) => /\b(credit|credits)\s+exceeded\b/i.test(msg), retryAfter: 3600_000},
]

/**
 * ServerError 模式匹配
 * - HTTP 5xx
 * - 消息包含 server error, internal error
 */
const serverErrorPatterns: Array<{test: (msg: string) => boolean; retryAfter: number}> = [
    {test: (msg) => /\binternal.server.error\b/i.test(msg), retryAfter: 10_000},
    {test: (msg) => /\bservice\s+(temporarily\s+)?unavailable\b/i.test(msg), retryAfter: 30_000},
    {test: (msg) => /\bbad.gateway\b/i.test(msg), retryAfter: 10_000},
    {test: (msg) => /\bgateway.timeout\b/i.test(msg), retryAfter: 15_000},
]

// ============================================
// 核心分类逻辑
// ============================================

/**
 * 分类 RateLimit 错误
 */
const classifyRateLimit = (msg: string, err: any): {type: ErrorType; retryable: boolean; retryAfter?: number} | null => {
    for (const p of rateLimitPatterns) {
        if (p.test(msg, err)) {
            return {type: ErrorType.RateLimit, retryable: true, retryAfter: p.retryAfter}
        }
    }
    return null
}

/**
 * 分类 Auth 错误
 */
const classifyAuth = (msg: string, err: any): {type: ErrorType; retryable: boolean; retryAfter?: number} | null => {
    for (const p of authPatterns) {
        if (p.test(msg, err)) {
            return {type: ErrorType.Auth, retryable: false}
        }
    }
    return null
}

/**
 * 分类 Timeout 错误
 * 注意：错误码检查(ETIMEDOUT/ESOCKETTIMEDOUT)由 classifyByErrorCode 统一处理
 */
const classifyTimeout = (msg: string, _err: any): {type: ErrorType; retryable: boolean; retryAfter?: number} | null => {
    // _err 保留未使用以保持与分类器函数签名一致
    for (const p of timeoutPatterns) {
        if (p.test(msg)) {
            return {type: ErrorType.Timeout, retryable: true, retryAfter: p.retryAfter}
        }
    }
    return null
}

/**
 * 分类 Network 错误
 */
const classifyNetwork = (msg: string, err: any): {type: ErrorType; retryable: boolean; retryAfter?: number} | null => {
    const code = err.code
    for (const p of networkPatterns) {
        if (p.test(msg, code)) {
            return {type: ErrorType.Network, retryable: true, retryAfter: p.retryAfter}
        }
    }
    return null
}

/**
 * 分类 QuotaExceeded 错误
 */
const classifyQuota = (msg: string, _err: any): {type: ErrorType; retryable: boolean; retryAfter?: number} | null => {
    // _err 保留未使用以保持与分类器函数签名一致
    for (const p of quotaPatterns) {
        if (p.test(msg)) {
            return {type: ErrorType.QuotaExceeded, retryable: false, retryAfter: p.retryAfter}
        }
    }
    return null
}

/**
 * 分类 ServerError 错误
 */
const classifyServer = (msg: string, _err: any): {type: ErrorType; retryable: boolean; retryAfter?: number} | null => {
    // _err 保留未使用以保持与分类器函数签名一致
    for (const p of serverErrorPatterns) {
        if (p.test(msg)) {
            return {type: ErrorType.ServerError, retryable: true, retryAfter: p.retryAfter}
        }
    }
    return null
}

/**
 * 增强的错误分类器
 *
 * 使用多维度检查：
 * 1. HTTP 状态码（最高优先级）
 * 2. 错误码
 * 3. 错误类型标识
 * 4. 错误消息模式匹配
 */
export function classifyErrorEnhanced(error: Error): ClassifiedError {
    if (!error) {
        return {
            type: ErrorType.Unknown,
            retryable: true,
            originalError: new Error('Unknown error: null or undefined')
        }
    }

    const err = error as any
    const message = extractErrorMessage(error)
    const status = getHttpStatus(err)
    const code = getErrorCode(err)
    const errorType = getErrorType(err)

    // ── 1. HTTP 状态码检查（最高优先级）────────────────────────────
    if (status !== undefined) {
        // 401/403 → Auth (不可重试)
        if (status === 401 || status === 403) {
            return {
                type: ErrorType.Auth,
                retryable: false,
                originalError: error
            }
        }

        // 429 → RateLimit (可重试)
        if (status === 429) {
            // 尝试从响应头获取 retry-after
            const retryAfter = err.response?.headers?.['retry-after']
            const retryAfterMs = retryAfter
                ? (Number(retryAfter) * 1000) // 秒转毫秒
                : 60_000 // 默认 1 分钟
            return {
                type: ErrorType.RateLimit,
                retryable: true,
                retryAfter: retryAfterMs,
                originalError: error
            }
        }

        // 500-599 → ServerError (可重试)
        if (status >= 500 && status <= 599) {
            return {
                type: ErrorType.ServerError,
                retryable: true,
                retryAfter: getRetryAfterForStatus(status),
                originalError: error
            }
        }

        // 400/404/422 → 通常不可重试
        if (status === 400 || status === 404 || status === 422) {
            // 但需要进一步检查是否是 context length 问题（可能可重试）
            if (isContextLengthError(err)) {
                return {
                    type: ErrorType.Unknown,
                    retryable: false,
                    originalError: error
                }
            }
            return {
                type: ErrorType.Unknown,
                retryable: false,
                originalError: error
            }
        }
    }

    // ── 2. 错误码检查 ────────────────────────────────────────────
    if (code) {
        const codeResult = classifyByErrorCode(code, message)
        if (codeResult) {
            return {...codeResult, originalError: error}
        }
    }

    // ── 3. 错误类型标识检查 ──────────────────────────────────────
    if (errorType) {
        const typeResult = classifyByErrorType(errorType, message)
        if (typeResult) {
            return {...typeResult, originalError: error}
        }
    }

    // ── 4. 错误消息模式匹配（按优先级）──────────────────────────
    const classifiers = [
        {fn: classifyRateLimit, fallbackRetryAfter: 60_000},
        {fn: classifyAuth, fallbackRetryAfter: 0},
        {fn: classifyServer, fallbackRetryAfter: 10_000},  // ServerError 在 Timeout 之前，优先匹配 gateway timeout
        {fn: classifyTimeout, fallbackRetryAfter: 5_000},
        {fn: classifyNetwork, fallbackRetryAfter: 5_000},
        {fn: classifyQuota, fallbackRetryAfter: 3600_000},
        {fn: classifyServer, fallbackRetryAfter: 10_000},
    ]

    for (const {fn, fallbackRetryAfter} of classifiers) {
        const result = fn(message, err)
        if (result) {
            return {
                ...result,
                retryAfter: result.retryAfter ?? fallbackRetryAfter,
                originalError: error
            }
        }
    }

    // ── 5. 未知错误（保守处理：默认可重试）─────────────────────
    logger.debug('[ErrorClassifier]', {
        action: 'unknown-error',
        message: message.substring(0, 100)
    })

    return {
        type: ErrorType.Unknown,
        retryable: true,
        retryAfter: 5_000,
        originalError: error
    }
}

/**
 * 根据 HTTP 状态码获取建议重试延迟
 */
function getRetryAfterForStatus(status: number): number {
    switch (status) {
        case 500: return 5_000   // Internal Server Error
        case 502: return 10_000  // Bad Gateway
        case 503: return 30_000  // Service Unavailable
        case 504: return 15_000  // Gateway Timeout
        default: return 10_000
    }
}

/**
 * 根据错误码分类
 */
function classifyByErrorCode(code: string, _message: string): {type: ErrorType; retryable: boolean; retryAfter?: number} | null {
    const codeUpper = code.toUpperCase()

    // Timeout 相关
    if (codeUpper === 'ETIMEDOUT' || codeUpper === 'ESOCKETTIMEDOUT') {
        return {type: ErrorType.Timeout, retryable: true, retryAfter: 10_000}
    }

    // Network 相关
    if (codeUpper === 'ENOTFOUND') {
        return {type: ErrorType.Network, retryable: true, retryAfter: 5_000}
    }
    if (codeUpper === 'ECONNREFUSED') {
        return {type: ErrorType.Network, retryable: true, retryAfter: 3_000}
    }
    if (codeUpper === 'ECONNRESET' || codeUpper === 'EAI_AGAIN') {
        return {type: ErrorType.Network, retryable: true, retryAfter: 5_000}
    }

    return null
}

/**
 * 根据错误类型标识分类
 */
function classifyByErrorType(errorType: string, _message: string): {type: ErrorType; retryable: boolean} | null {
    const typeLower = errorType.toLowerCase()

    if (typeLower.includes('rate_limit') || typeLower.includes('ratelimit')) {
        return {type: ErrorType.RateLimit, retryable: true}
    }
    if (typeLower.includes('auth') || typeLower.includes('unauthorized')) {
        return {type: ErrorType.Auth, retryable: false}
    }
    if (typeLower.includes('timeout')) {
        return {type: ErrorType.Timeout, retryable: true}
    }
    if (typeLower.includes('network') || typeLower.includes('connection')) {
        return {type: ErrorType.Network, retryable: true}
    }
    if (typeLower.includes('quota')) {
        return {type: ErrorType.QuotaExceeded, retryable: false}
    }
    if (typeLower.includes('server_error') || typeLower.includes('servererror')) {
        return {type: ErrorType.ServerError, retryable: true}
    }

    return null
}

/**
 * 判断是否为上下文长度错误
 */
function isContextLengthError(err: any): boolean {
    const message = (err.message || '').toLowerCase()
    return message.includes('context length') ||
        message.includes('maximum context') ||
        message.includes('token limit') ||
        message.includes('reduce') ||
        message.includes('prompt is too long') ||
        message.includes('maximum tokens')
}

// ============================================
// 向后兼容的 API
// ============================================

/**
 * 向后兼容的 classifyError 函数
 *
 * @deprecated 使用 classifyErrorEnhanced 获取更详细的错误信息
 */
export function classifyError(error: Error): 'retryable' | 'permanent' {
    const result = classifyErrorEnhanced(error)
    return result.retryable ? 'retryable' : 'permanent'
}

/**
 * 向后兼容的 getRetryDelay 函数
 *
 * @deprecated 使用 classifyErrorEnhanced 获取更准确的延迟建议
 */
export function getRetryDelay(error: Error): number {
    const result = classifyErrorEnhanced(error)
    return result.retryAfter ?? 5_000
}

// ============================================
// 便捷构造函数
// ============================================

/**
 * 创建 RetryableError 的便捷函数
 */
export function createRetryableError(
    message: string,
    type: ErrorType,
    retryAfter?: number,
    cause?: Error
): Error & {retryable: true; errorType: ErrorType; retryAfter?: number; cause?: Error} {
    const error = new Error(message) as Error & {retryable: true; errorType: ErrorType; retryAfter?: number; cause?: Error}
    error.name = 'RetryableError'
    error.retryable = true
    error.errorType = type
    error.retryAfter = retryAfter
    error.cause = cause
    return error
}

/**
 * 创建 PermanentError 的便捷函数
 */
export function createPermanentError(
    message: string,
    type: ErrorType,
    code?: string,
    cause?: Error
): Error & {retryable: false; errorType: ErrorType; code?: string} {
    const error = new Error(message) as Error & {retryable: false; errorType: ErrorType; code?: string; cause?: Error}
    error.name = 'PermanentError'
    error.retryable = false
    error.errorType = type
    error.code = code
    error.cause = cause
    return error
}

// ============================================
// 导出所有类型（已在本文件中定义）
// ============================================

// 类型已在文件顶部通过 `export enum` / `export interface` 导出
// 此处仅导出函数供外部调用
