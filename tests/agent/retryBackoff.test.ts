import {describe, it, expect, vi} from 'vitest'
import {retryBackoff, extractErrorDetail} from '../../src/main/agent/loop/execute'

// vitest 假定时器，避免真实等待 5 秒
describe('retryBackoff', () => {
    const error = new Error('connection refused')

    it('先发 1 次 warning，再每秒发 retryCountdown 递减事件', async () => {
        vi.useFakeTimers()
        const gen = retryBackoff(1, 10, error, 3000, undefined)
        const events: any[] = []
        const pump = async () => {
            for (;;) {
                const {done, value} = await gen.next()
                if (done) break
                events.push(value)
            }
        }
        const pumping = pump()
        // 等 3 秒（3 个 1 秒 tick）
        for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(1000)
            await Promise.resolve()
        }
        await pumping
        vi.useRealTimers()

        expect(events[0]).toEqual({type: 'warning', message: 'retry 1/10：connection refused'})
        const countdowns = events.filter(e => e.type === 'tool_progress')
        expect(countdowns.length).toBe(3)
        expect(countdowns.map(e => e.retryCountdown)).toEqual([3, 2, 1])
        expect(countdowns[0].progress).toContain('3s 后重试...')
    })

    it('abort 后立即停止，不再发倒计时，且 yield 已取消重试 warning', async () => {
        vi.useFakeTimers()
        const ac = new AbortController()
        const gen = retryBackoff(2, 10, error, 5000, ac.signal)
        const events: any[] = []
        const pump = async () => {
            for (;;) {
                const {done, value} = await gen.next()
                if (done) break
                events.push(value)
            }
        }
        const pumping = pump()
        // 第一个 1 秒 tick 完成前中止（500ms < 1000ms），确保 abort 时已发 1 次倒计时
        await vi.advanceTimersByTimeAsync(500)
        await Promise.resolve()
        ac.abort()
        await vi.advanceTimersByTimeAsync(5000)
        await Promise.resolve()
        await pumping
        vi.useRealTimers()

        expect(events.filter(e => e.type === 'tool_progress').length).toBe(1)
        // abort 后必须 yield "已取消重试" warning，明确提示等待已终止
        const cancelWarnings = events.filter(e => e.type === 'warning' && e.message.includes('已取消重试'))
        expect(cancelWarnings).toHaveLength(1)
        expect(cancelWarnings[0].message).toBe('retry 2/10：已取消重试')
    })

    it('无 abortSignal 参数时兼容（undefined）', async () => {
        vi.useFakeTimers()
        const gen = retryBackoff(1, 10, error, 1000, undefined)
        const events: any[] = []
        const pump = async () => {
            for (;;) {
                const {done, value} = await gen.next()
                if (done) break
                events.push(value)
            }
        }
        const pumping = pump()
        await vi.advanceTimersByTimeAsync(1000)
        await Promise.resolve()
        await pumping
        vi.useRealTimers()
        expect(events.length).toBe(2) // 1 warning + 1 countdown
    })

    it('warning 与 progress 携带响应体真实错误详情（OpenAI 风格 {error:{message}}）', async () => {
        vi.useFakeTimers()
        const sdkError: any = new Error('400 Provider returned error')
        sdkError.status = 400
        sdkError.response = {
            status: 400,
            data: {error: {message: 'Invalid parameter: max_tokens must be <= 8192', type: 'invalid_request_error'}},
        }
        const gen = retryBackoff(1, 10, sdkError, 3000, undefined)
        const events: any[] = []
        const pump = async () => {
            for (;;) {
                const {done, value} = await gen.next()
                if (done) break
                events.push(value)
            }
        }
        const pumping = pump()
        for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(1000)
            await Promise.resolve()
        }
        await pumping
        vi.useRealTimers()

        // warning：状态码 + 响应体详情，而非 SDK 泛化 message
        expect(events[0]).toEqual({
            type: 'warning',
            message: 'retry 1/10：400 Invalid parameter: max_tokens must be <= 8192',
        })
        // 每秒倒计时同样携带详情（渲染端直接展示 progress），包含剩余秒数
        const countdowns = events.filter(e => e.type === 'tool_progress')
        expect(countdowns[0].progress).toBe('重试 1/10：400 Invalid parameter: max_tokens must be <= 8192，3s 后重试...')
    })
})

describe('extractErrorDetail', () => {
    it('响应体详情优先（OpenAI 风格 {error:{message}}，带状态码前缀）', () => {
        const err: any = new Error('400 Provider returned error')
        err.status = 400
        err.response = {status: 400, data: {error: {message: 'Invalid parameter: max_tokens must be <= 8192'}}}
        expect(extractErrorDetail(err)).toBe('400 Invalid parameter: max_tokens must be <= 8192')
    })

    it('响应体为纯字符串 / {message} / {error: string} 形态均可提取', () => {
        expect(extractErrorDetail({response: {data: 'raw body text'}})).toBe('raw body text')
        expect(extractErrorDetail({response: {data: {message: 'msg from body'}}})).toBe('msg from body')
        expect(extractErrorDetail({response: {data: {error: 'err string'}}})).toBe('err string')
    })

    it('OpenAI SDK v4 APIError 形态：error.error 直接是响应体对象（无 response 包装）', () => {
        const apiError: any = new Error('400 Provider returned error')
        apiError.status = 400
        apiError.error = {message: 'The model `gpt-4.1` does not exist', type: 'invalid_request_error', code: 'model_not_found'}
        expect(extractErrorDetail(apiError)).toBe('400 The model `gpt-4.1` does not exist')
    })

    it('OpenAI SDK v4 APIError 形态：error.error 为纯字符串 body', () => {
        const apiError: any = new Error('400 Provider returned error')
        apiError.status = 400
        apiError.error = 'raw provider body text'
        expect(extractErrorDetail(apiError)).toBe('400 raw provider body text')
    })

    it('响应体详情后附加补充字段（type/code/request_id），便于复制后排查', () => {
        const apiError: any = new Error('400 Provider returned error')
        apiError.status = 400
        apiError.error = {message: 'Provider returned error', type: 'invalid_request_error'}
        apiError.type = 'invalid_request_error'
        apiError.request_id = 'req_abc123'
        expect(extractErrorDetail(apiError)).toBe('400 Provider returned error（type: invalid_request_error，request_id: req_abc123）')
    })

    it('补充字段与详情相同时不重复附加', () => {
        const err: any = new Error('400 dup')
        err.status = 400
        err.error = {message: 'dup'}
        err.type = 'dup' // 与详情相同 → 跳过
        expect(extractErrorDetail(err)).toBe('400 dup')
    })

    it('无响应体：合并 cause 链 message', () => {
        const err: any = new Error('base error')
        err.cause = new Error('cause detail')
        expect(extractErrorDetail(err)).toBe('base error; cause detail')
    })

    it('多行/多余空白压缩为单行', () => {
        expect(extractErrorDetail(new Error('  line1\n  line2  '))).toBe('line1 line2')
    })

    it('空值/无 message 回退 network_error', () => {
        expect(extractErrorDetail(null)).toBe('network_error')
        expect(extractErrorDetail({})).toBe('network_error')
    })
})
