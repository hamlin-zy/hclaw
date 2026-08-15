/**
 * errorClassifier 错误分类模块单元测试
 *
 * 依据源码真实行为编写（src/main/agent/common/errorClassifier.ts）：
 * - 分类优先级：HTTP 状态码 > 错误码(code) > 错误类型标识(type/errorType/name) > 错误消息模式
 * - extractErrorMessage 遍历 cause 链拼接消息（`; ` 分隔）
 * - HTTP 429 的 retry-after 仅从 error.response.headers 读取（秒→毫秒），否则默认 60_000ms
 * - 消息正则注意：\bnetwork.error\b 才匹配网络错误（单独 "network" 不命中）；
 *   timeout 排除 "gateway/connection/server timeout"；quota 需 "quota exceeded"/"quota_exceeded"
 * - 未知错误保守处理：retryable=true, retryAfter=5_000
 *
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {
  classifyError,
  classifyErrorEnhanced,
  createPermanentError,
  createRetryableError,
  ErrorType,
  getRetryDelay,
} from '@/main/agent/common/errorClassifier'

// ─── 辅助函数 ─────────────────────────────────────────

/** 构造带附加属性的 Error（status/code/response 等） */
const withProps = (message: string, props: Record<string, unknown>): Error =>
  Object.assign(new Error(message), props)

// ─── RateLimit ─────────────────────────────────────────

describe('errorClassifier — RateLimit', () => {
  it('HTTP 429 → RATE_LIMIT, retryable=true', () => {
    const err = withProps('too many requests', {status: 429})
    const result = classifyErrorEnhanced(err)

    expect(result.type).toBe(ErrorType.RateLimit)
    expect(result.retryable).toBe(true)
    expect(result.originalError).toBe(err)
  })

  it('HTTP 429 从 response.headers["retry-after"] 提取延迟（秒→毫秒）', () => {
    const err = withProps('x', {status: 429, response: {headers: {'retry-after': '7'}}})
    const result = classifyErrorEnhanced(err)

    expect(result.type).toBe(ErrorType.RateLimit)
    expect(result.retryAfter).toBe(7_000)
  })

  it('HTTP 429 无 retry-after 头 → 默认 60_000ms', () => {
    const result = classifyErrorEnhanced(withProps('x', {status: 429}))
    expect(result.retryAfter).toBe(60_000)
  })

  it('消息含 "rate limit" → RATE_LIMIT', () => {
    const result = classifyErrorEnhanced(new Error('API rate limit exceeded'))
    expect(result.type).toBe(ErrorType.RateLimit)
    expect(result.retryable).toBe(true)
    expect(result.retryAfter).toBe(60_000)
  })

  it('消息含 "rate_limit"（下划线）→ RATE_LIMIT', () => {
    const result = classifyErrorEnhanced(new Error('rate_limit reached for org'))
    expect(result.type).toBe(ErrorType.RateLimit)
  })

  it('消息含 "too many requests" → RATE_LIMIT', () => {
    const result = classifyErrorEnhanced(new Error('Too many requests, slow down'))
    expect(result.type).toBe(ErrorType.RateLimit)
  })

  it('消息含 "over rate" → RATE_LIMIT', () => {
    const result = classifyErrorEnhanced(new Error('over rate limit for this key'))
    expect(result.type).toBe(ErrorType.RateLimit)
  })
})

// ─── Auth ──────────────────────────────────────────────

describe('errorClassifier — Auth', () => {
  it('HTTP 401 → AUTH, retryable=false', () => {
    const result = classifyErrorEnhanced(withProps('x', {status: 401}))
    expect(result.type).toBe(ErrorType.Auth)
    expect(result.retryable).toBe(false)
  })

  it('HTTP 403 → AUTH, retryable=false', () => {
    const result = classifyErrorEnhanced(withProps('forbidden', {status: 403}))
    expect(result.type).toBe(ErrorType.Auth)
    expect(result.retryable).toBe(false)
  })

  it('消息含 "unauthorized" → AUTH', () => {
    const result = classifyErrorEnhanced(new Error('401 unauthorized access'))
    expect(result.type).toBe(ErrorType.Auth)
    expect(result.retryable).toBe(false)
  })

  it('消息含 "invalid api key" → AUTH', () => {
    const result = classifyErrorEnhanced(new Error('Invalid api key provided'))
    expect(result.type).toBe(ErrorType.Auth)
  })

  it('消息含 "incorrect api key" → AUTH', () => {
    const result = classifyErrorEnhanced(new Error('incorrect api key supplied'))
    expect(result.type).toBe(ErrorType.Auth)
  })

  it('消息含 "authentication failed"（auth.*fail）→ AUTH', () => {
    const result = classifyErrorEnhanced(new Error('authentication failed'))
    expect(result.type).toBe(ErrorType.Auth)
  })

  it('消息含 "invalid access token" / "token has expired" → AUTH', () => {
    expect(classifyErrorEnhanced(new Error('invalid access token')).type).toBe(ErrorType.Auth)
    expect(classifyErrorEnhanced(new Error('token has expired')).type).toBe(ErrorType.Auth)
  })

  it('错误类型标识含 "authentication" → AUTH', () => {
    const result = classifyErrorEnhanced(withProps('x', {errorType: 'authentication_error'}))
    expect(result.type).toBe(ErrorType.Auth)
    expect(result.retryable).toBe(false)
  })
})

// ─── Timeout ───────────────────────────────────────────

describe('errorClassifier — Timeout', () => {
  it('消息含 "timeout" → TIMEOUT, retryable=true', () => {
    const result = classifyErrorEnhanced(new Error('request timeout'))
    expect(result.type).toBe(ErrorType.Timeout)
    expect(result.retryable).toBe(true)
    expect(result.retryAfter).toBe(5_000)
  })

  it('消息含 "timed out"（不是 timeout 词元）→ 不分类为 Timeout', () => {
    // 源码 timeout 消息正则为 \btimeout\b，"timed out" 不含 "timeout" 词，不命中
    const result = classifyErrorEnhanced(new Error('request timed out'))
    expect(result.type).not.toBe(ErrorType.Timeout)
  })

  it('code=ETIMEDOUT → TIMEOUT, retryAfter=10_000', () => {
    const result = classifyErrorEnhanced(withProps('socket timed out', {code: 'ETIMEDOUT'}))
    expect(result.type).toBe(ErrorType.Timeout)
    expect(result.retryAfter).toBe(10_000)
  })

  it('code=ESOCKETTIMEDOUT → TIMEOUT', () => {
    const result = classifyErrorEnhanced(withProps('x', {code: 'ESOCKETTIMEDOUT'}))
    expect(result.type).toBe(ErrorType.Timeout)
  })

  it('"connection timeout" 被排除 → 不分类为 Timeout（按源码行为，fallback 处理）', () => {
    // 源码 timeout 正则显式排除 gateway/connection/server timeout
    const result = classifyErrorEnhanced(new Error('connection timed out'))
    expect(result.type).not.toBe(ErrorType.Timeout)
  })

  it('错误名称 TimeoutError → TIMEOUT', () => {
    const result = classifyErrorEnhanced(withProps('x', {name: 'TimeoutError'}))
    expect(result.type).toBe(ErrorType.Timeout)
  })
})

// ─── Network ───────────────────────────────────────────

describe('errorClassifier — Network', () => {
  it('code=ECONNREFUSED → NETWORK, retryAfter=3_000', () => {
    const result = classifyErrorEnhanced(withProps('connect refused', {code: 'ECONNREFUSED'}))
    expect(result.type).toBe(ErrorType.Network)
    expect(result.retryable).toBe(true)
    expect(result.retryAfter).toBe(3_000)
  })

  it('code=ENOTFOUND → NETWORK, retryAfter=5_000', () => {
    const result = classifyErrorEnhanced(withProps('getaddrinfo', {code: 'ENOTFOUND'}))
    expect(result.type).toBe(ErrorType.Network)
    expect(result.retryAfter).toBe(5_000)
  })

  it('code=ECONNRESET → NETWORK', () => {
    const result = classifyErrorEnhanced(withProps('socket hang up', {code: 'ECONNRESET'}))
    expect(result.type).toBe(ErrorType.Network)
    expect(result.retryAfter).toBe(5_000)
  })

  it('消息含 "connection refused" → NETWORK, retryAfter=3_000', () => {
    const result = classifyErrorEnhanced(new Error('connection refused by host'))
    expect(result.type).toBe(ErrorType.Network)
    expect(result.retryAfter).toBe(3_000)
  })

  it('消息含 "network error" → NETWORK', () => {
    const result = classifyErrorEnhanced(new Error('network error while sending'))
    expect(result.type).toBe(ErrorType.Network)
  })

  it('消息单独含 "network"（非 "network error"）→ 不分类为 Network', () => {
    // 源码 network 消息正则要求 \bnetwork.error\b
    expect(classifyErrorEnhanced(new Error('network')).type).not.toBe(ErrorType.Network)
  })

  it('消息含 "socket hang up" 但无错误码 → 按源码不分类为 Network', () => {
    // "socket hang up" 不是源码中的消息模式，仅当 code=ECONNRESET 时命中
    expect(classifyErrorEnhanced(new Error('socket hang up')).type).not.toBe(ErrorType.Network)
  })
})

// ─── QuotaExceeded ─────────────────────────────────────

describe('errorClassifier — QuotaExceeded', () => {
  it('消息含 "quota exceeded" → QUOTA_EXCEEDED', () => {
    const result = classifyErrorEnhanced(new Error('quota exceeded for this period'))
    expect(result.type).toBe(ErrorType.QuotaExceeded)
    expect(result.retryable).toBe(false)
    expect(result.retryAfter).toBe(3_600_000)
  })

  it('消息含 "quota_exceeded" → QUOTA_EXCEEDED', () => {
    const result = classifyErrorEnhanced(new Error('quota_exceeded for org 42'))
    expect(result.type).toBe(ErrorType.QuotaExceeded)
  })

  it('消息含 "monthly limit" → QUOTA_EXCEEDED, retryAfter=1 天', () => {
    const result = classifyErrorEnhanced(new Error('monthly limit reached'))
    expect(result.type).toBe(ErrorType.QuotaExceeded)
    expect(result.retryAfter).toBe(86_400_000)
  })

  it('消息含 "daily request limit" → QUOTA_EXCEEDED', () => {
    const result = classifyErrorEnhanced(new Error('daily request limit exceeded'))
    expect(result.type).toBe(ErrorType.QuotaExceeded)
  })

  it('消息含 "credits exceeded" → QUOTA_EXCEEDED', () => {
    const result = classifyErrorEnhanced(new Error('credits exceeded'))
    expect(result.type).toBe(ErrorType.QuotaExceeded)
  })

  it('错误类型标识含 "quota" → QUOTA_EXCEEDED', () => {
    const result = classifyErrorEnhanced(withProps('x', {errorType: 'insufficient_quota'}))
    expect(result.type).toBe(ErrorType.QuotaExceeded)
    expect(result.retryable).toBe(false)
  })

  it('消息单独含 "insufficient quota"（非 quota exceeded）→ 不分类为 QuotaExceeded', () => {
    // 源码 quota 消息模式不匹配 "insufficient quota"
    expect(classifyErrorEnhanced(new Error('insufficient quota')).type).not.toBe(ErrorType.QuotaExceeded)
  })
})

// ─── ServerError ───────────────────────────────────────

describe('errorClassifier — ServerError', () => {
  it('HTTP 500 → SERVER_ERROR, retryAfter=5_000', () => {
    const result = classifyErrorEnhanced(withProps('boom', {status: 500}))
    expect(result.type).toBe(ErrorType.ServerError)
    expect(result.retryable).toBe(true)
    expect(result.retryAfter).toBe(5_000)
  })

  it('HTTP 502 → SERVER_ERROR, retryAfter=10_000', () => {
    const result = classifyErrorEnhanced(withProps('bad upstream', {statusCode: 502}))
    expect(result.type).toBe(ErrorType.ServerError)
    expect(result.retryAfter).toBe(10_000)
  })

  it('HTTP 503（response.status）→ SERVER_ERROR, retryAfter=30_000', () => {
    const result = classifyErrorEnhanced(withProps('x', {response: {status: 503}}))
    expect(result.type).toBe(ErrorType.ServerError)
    expect(result.retryAfter).toBe(30_000)
  })

  it('HTTP 504 → SERVER_ERROR, retryAfter=15_000', () => {
    const result = classifyErrorEnhanced(withProps('x', {status: 504}))
    expect(result.type).toBe(ErrorType.ServerError)
    expect(result.retryAfter).toBe(15_000)
  })

  it('消息含 "internal server error" → SERVER_ERROR, retryAfter=10_000', () => {
    const result = classifyErrorEnhanced(new Error('internal server error occurred'))
    expect(result.type).toBe(ErrorType.ServerError)
    expect(result.retryAfter).toBe(10_000)
  })

  it('消息含 "service unavailable" → SERVER_ERROR', () => {
    const result = classifyErrorEnhanced(new Error('service temporarily unavailable'))
    expect(result.type).toBe(ErrorType.ServerError)
  })

  it('消息含 "bad gateway" → SERVER_ERROR', () => {
    const result = classifyErrorEnhanced(new Error('bad gateway from upstream'))
    expect(result.type).toBe(ErrorType.ServerError)
  })

  it('消息含 "gateway timeout" → SERVER_ERROR（而非 Timeout）, retryAfter=15_000', () => {
    const result = classifyErrorEnhanced(new Error('gateway timeout'))
    expect(result.type).toBe(ErrorType.ServerError)
    expect(result.retryAfter).toBe(15_000)
  })

  it('错误名称 ServerError → SERVER_ERROR', () => {
    const result = classifyErrorEnhanced(withProps('x', {name: 'ServerError'}))
    expect(result.type).toBe(ErrorType.ServerError)
  })
})

// ─── Unknown / 400 系列 ────────────────────────────────

describe('errorClassifier — Unknown 与 400 系列', () => {
  it('未知消息 → UNKNOWN, retryable=true（保守可重试）, retryAfter=5_000', () => {
    const result = classifyErrorEnhanced(new Error('some random thing happened'))
    expect(result.type).toBe(ErrorType.Unknown)
    expect(result.retryable).toBe(true)
    expect(result.retryAfter).toBe(5_000)
  })

  it('HTTP 400 → UNKNOWN, retryable=false', () => {
    const result = classifyErrorEnhanced(withProps('bad request', {status: 400}))
    expect(result.type).toBe(ErrorType.Unknown)
    expect(result.retryable).toBe(false)
  })

  it('HTTP 404 → UNKNOWN, retryable=false', () => {
    const result = classifyErrorEnhanced(withProps('not found', {status: 404}))
    expect(result.type).toBe(ErrorType.Unknown)
    expect(result.retryable).toBe(false)
  })

  it('HTTP 422 → UNKNOWN, retryable=false', () => {
    const result = classifyErrorEnhanced(withProps('invalid request body', {status: 422}))
    expect(result.type).toBe(ErrorType.Unknown)
    expect(result.retryable).toBe(false)
  })

  it('HTTP 422 且为 context length 错误 → UNKNOWN, retryable=false（源码如此）', () => {
    const result = classifyErrorEnhanced(withProps('maximum context length exceeded', {status: 422}))
    expect(result.type).toBe(ErrorType.Unknown)
    expect(result.retryable).toBe(false)
  })

  it('null/undefined 输入 → UNKNOWN（防御）', () => {
    const result = classifyErrorEnhanced(null as unknown as Error)
    expect(result.type).toBe(ErrorType.Unknown)
    expect(result.retryable).toBe(true)
  })
})

// ─── cause 链与字段提取 ────────────────────────────────

describe('errorClassifier — cause 链与结构化字段', () => {
  it('外层消息普通但 cause.message 含 "rate limit" → RATE_LIMIT', () => {
    const cause = new Error('rate limit exceeded')
    const outer = withProps('something went wrong', {cause})
    const result = classifyErrorEnhanced(outer)

    expect(result.type).toBe(ErrorType.RateLimit)
    expect(result.retryable).toBe(true)
  })

  it('cause 链更深层命中 quota → QUOTA_EXCEEDED', () => {
    const inner = new Error('quota_exceeded')
    const mid = withProps('call failed', {cause: inner})
    const outer = withProps('task aborted', {cause: mid})

    expect(classifyErrorEnhanced(outer).type).toBe(ErrorType.QuotaExceeded)
  })

  it('error.status=429（无 message 线索）→ RATE_LIMIT', () => {
    const err = withProps('op failed', {status: 429})
    expect(classifyErrorEnhanced(err).type).toBe(ErrorType.RateLimit)
  })

  it('error.response.status=503（无 message 线索）→ SERVER_ERROR', () => {
    const err = withProps('op failed', {response: {status: 503}})
    expect(classifyErrorEnhanced(err).type).toBe(ErrorType.ServerError)
  })

  it('error.code 优先于 message（code=ENOTFOUND 但消息含 rate limit）', () => {
    // 分类优先级：状态码 > code > 类型标识 > 消息模式
    const err = withProps('rate limit hit', {code: 'ENOTFOUND'})
    expect(classifyErrorEnhanced(err).type).toBe(ErrorType.Network)
  })

  it('error.response 深层字段（data.error.type）→ 受 error.name 短路影响不提取', () => {
    // 已知源码行为：getErrorType 的 `||` 链中 error.name（始终为 "Error"）先于
    // response.data.error.type 短路，导致深层字段无法被读取 → 归类为 Unknown
    const err = withProps('x', {response: {data: {error: {type: 'rate_limit_exceeded'}}}})
    const result = classifyErrorEnhanced(err)
    expect(result.type).toBe(ErrorType.Unknown)
  })
})

// ─── getRetryDelay ─────────────────────────────────────

describe('errorClassifier — getRetryDelay', () => {
  it('RateLimit 返回 retry-after 头（秒→毫秒）', () => {
    const err = withProps('x', {status: 429, response: {headers: {'retry-after': '5'}}})
    expect(getRetryDelay(err)).toBe(5_000)
  })

  it('RateLimit 无头返回默认 60_000', () => {
    expect(getRetryDelay(withProps('x', {status: 429}))).toBe(60_000)
  })

  it('不同状态码返回对应延迟（503→30s）', () => {
    expect(getRetryDelay(withProps('x', {status: 503}))).toBe(30_000)
  })

  it('未知错误返回 5_000', () => {
    expect(getRetryDelay(new Error('random'))).toBe(5_000)
  })
})

// ─── 旧接口 classifyError ──────────────────────────────

describe('errorClassifier — classifyError（向后兼容）', () => {
  it('可重试错误返回 "retryable"', () => {
    expect(classifyError(new Error('rate limit exceeded'))).toBe('retryable')
    expect(classifyError(withProps('x', {code: 'ETIMEDOUT'}))).toBe('retryable')
  })

  it('不可重试错误返回 "permanent"', () => {
    expect(classifyError(new Error('unauthorized'))).toBe('permanent')
    expect(classifyError(withProps('x', {status: 401}))).toBe('permanent')
  })
})

// ─── 便捷构造函数 ─────────────────────────────────────

describe('errorClassifier — createRetryableError / createPermanentError', () => {
  it('createRetryableError(类型=RateLimit, retryAfter=12345) 可被正确分类', () => {
    const err = createRetryableError('boom', ErrorType.RateLimit, 12_345)
    const result = classifyErrorEnhanced(err)

    expect(result.type).toBe(ErrorType.RateLimit)
    expect(result.retryable).toBe(true)
    // 已知源码行为：通过 errorType 匹配时 classifyByErrorType 返回对象不含 retryAfter，
    // 且该分支无 fallback → retryAfter 为 undefined
    expect(result.retryAfter).toBeUndefined()
  })

  it('createRetryableError 不传 retryAfter → 分类结果无 retryAfter（getRetryDelay 兜底 5_000）', () => {
    const err = createRetryableError('boom', ErrorType.Timeout)
    const result = classifyErrorEnhanced(err)
    expect(result.type).toBe(ErrorType.Timeout)
    expect(result.retryable).toBe(true)
    expect(result.retryAfter).toBeUndefined()
    expect(getRetryDelay(err)).toBe(5_000)
  })

  it('createPermanentError(类型=Auth, code) 可被正确分类为不可重试', () => {
    const err = createPermanentError('nope', ErrorType.Auth, 'AUTH_FAILED')
    const result = classifyErrorEnhanced(err)

    expect(result.type).toBe(ErrorType.Auth)
    expect(result.retryable).toBe(false)
  })

  it('构造函数字段（name/retryable/errorType/cause）注入正确', () => {
    const cause = new Error('root cause')
    const retryErr = createRetryableError('x', ErrorType.Network, 3_000, cause)
    expect(retryErr.name).toBe('RetryableError')
    expect(retryErr.retryable).toBe(true)
    expect(retryErr.errorType).toBe(ErrorType.Network)
    expect(retryErr.cause).toBe(cause)

    const permErr = createPermanentError('y', ErrorType.Auth, 'E_AUTH', cause)
    expect(permErr.name).toBe('PermanentError')
    expect(permErr.retryable).toBe(false)
    expect(permErr.code).toBe('E_AUTH')
  })
})
