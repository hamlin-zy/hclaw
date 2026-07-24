/**
 * updateChecker service 单测
 *
 * 覆盖设计文档中的 9 个用例：
 *   1. update-available
 *   2. up-to-date
 *   3. prerelease（已被 /releases/latest 过滤，mock 层不验证 — 此处验证 graceful）
 *   4. 网络错误 → network code
 *   5. 403 + X-RateLimit-Reset → rate-limit code
 *   6. 404 → parse code
 *   7. 非 semver tag → graceful up-to-date
 *   8. TTL 9 分钟内连续 2 次 → 第 2 次不调 axios
 *   9. TTL 11 分钟后 → 调 axios
 *   10. 并发 2 次 checkForUpdate → 只 1 次 axios 调用
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock electron.app.getVersion ──
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.2.87'),
  },
}))

// ── mock axios ──
vi.mock('axios', () => ({
  default: {
    isAxiosError: vi.fn((err: any) => err && err.__isAxiosError === true),
    get: vi.fn(),
  },
}))

import axios from 'axios'
import {
  __resetCacheForTesting,
  checkForUpdate,
  getStatus,
  init,
} from '../../../src/main/updater/updateChecker'

const mockedAxiosGet = axios.get as unknown as ReturnType<typeof vi.fn>
const mockedIsAxiosError = axios.isAxiosError as unknown as ReturnType<typeof vi.fn>

/** 构造一个 axios 风格的错误对象 */
function makeAxiosError(opts: {
  code?: string
  status?: number
  headers?: Record<string, string>
  message?: string
}): any {
  const err: any = new Error(opts.message ?? 'axios error')
  err.__isAxiosError = true
  err.code = opts.code
  err.message = opts.message ?? 'axios error'
  if (opts.status !== undefined) {
    err.response = { status: opts.status, headers: opts.headers ?? {} }
  }
  return err
}

beforeEach(() => {
  __resetCacheForTesting()
  mockedAxiosGet.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('updateChecker — happy path', () => {
  it('GitHub 返回 v0.2.88，本地 v0.2.87 → update-available', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: {
        tag_name: 'v0.2.88',
        body: '## 新功能\n- xxx',
        published_at: '2026-08-01T00:00:00Z',
        html_url: 'https://github.com/hamlin-zy/hclaw/releases/tag/v0.2.88',
      },
    })

    const result = await checkForUpdate()

    expect(result.status).toBe('update-available')
    expect(result.latestVersion).toBe('0.2.88')
    expect(result.currentVersion).toBe('0.2.87')
    expect(result.downloads.github).toBe(
      'https://github.com/hamlin-zy/hclaw/releases/tag/v0.2.88'
    )
    expect(result.downloads.baiduPan).toContain('pan.baidu.com')
    expect(result.releaseNotes).toBe('## 新功能\n- xxx')
    expect(result.publishedAt).toBe('2026-08-01T00:00:00Z')
    expect(result.error).toBeUndefined()
  })

  it('GitHub 返回 v0.2.86，本地 v0.2.87 → up-to-date', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: {
        tag_name: 'v0.2.86',
        body: '',
        published_at: '2026-07-01T00:00:00Z',
        html_url: 'https://github.com/hamlin-zy/hclaw/releases/tag/v0.2.86',
      },
    })

    const result = await checkForUpdate()

    expect(result.status).toBe('up-to-date')
    expect(result.latestVersion).toBe('0.2.87') // 填充为 currentVersion
    expect(result.currentVersion).toBe('0.2.87')
  })

  it('GitHub 返回 v0.2.87，本地 v0.2.87 → up-to-date（相等）', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.87', html_url: '...', published_at: '' },
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
  })

  it('GitHub 返回非 semver tag（如 garbage）→ graceful up-to-date', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'garbage', html_url: '...', published_at: '' },
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
    expect(result.latestVersion).toBe('0.2.87')
  })
})

describe('updateChecker — 错误分类', () => {
  it('ECONNREFUSED → network 错误', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
    expect(result.error?.message).toBe('网络异常')
  })

  it('ETIMEDOUT → network 错误', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError({ code: 'ETIMEDOUT' }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
  })

  it('ENOTFOUND → network 错误', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError({ code: 'ENOTFOUND' }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
  })

  it('HTTP 403 + X-RateLimit-Reset → rate-limit 错误（带分钟数）', async () => {
    const futureReset = Math.floor((Date.now() + 5 * 60 * 1000) / 1000)
    mockedAxiosGet.mockRejectedValueOnce(
      makeAxiosError({
        status: 403,
        headers: { 'x-ratelimit-reset': String(futureReset) },
        message: 'rate limit',
      })
    )
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('rate-limit')
    expect(result.error?.message).toMatch(/分钟后重试/)
  })

  it('HTTP 403 无 Reset header → rate-limit 错误（不显示分钟数）', async () => {
    mockedAxiosGet.mockRejectedValueOnce(
      makeAxiosError({ status: 403, headers: {} })
    )
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('rate-limit')
    expect(result.error?.message).toBe('请求频繁，请稍后再试')
  })

  it('HTTP 404 → parse 错误', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError({ status: 404 }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('parse')
    expect(result.error?.message).toBe('版本信息异常')
  })

  it('HTTP 500 → unknown 错误', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError({ status: 500 }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('unknown')
    expect(result.error?.message).toBe('检查失败')
  })

  it('非 axios 错误 → unknown', async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error('boom'))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('unknown')
  })

  it('axios.isAxiosError 返回 false 但错误有 status → unknown（不应误判为 axios 错误）', async () => {
    // 边界情况：__isAxiosError 没设置时
    mockedIsAxiosError.mockReturnValueOnce(false)
    mockedAxiosGet.mockRejectedValueOnce({ status: 500, message: 'fake' })
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('unknown')
  })
})

describe('updateChecker — 缓存行为', () => {
  it('init() 触发首次检查并填充缓存', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.88', html_url: '...', published_at: '' },
    })
    await init()
    const cached = await getStatus()
    expect(cached).not.toBeNull()
    expect(cached?.status).toBe('update-available')
  })

  it('getStatus() 在缓存为空时返回 null', async () => {
    const cached = await getStatus()
    expect(cached).toBeNull()
  })

  it('TTL 内连续 2 次 getStatus — 第 2 次返回缓存，不调 axios', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.88', html_url: '...', published_at: '' },
    })
    await checkForUpdate()
    // 此时 axios 已被调 1 次

    // 重置 mock 调用计数，但保留实现
    mockedAxiosGet.mockClear()

    // TTL 内 getStatus 应返回缓存，不再调 axios
    const cached = await getStatus()
    expect(cached).not.toBeNull()
    expect(mockedAxiosGet).not.toHaveBeenCalled()
  })

  it('TTL 内连续 2 次 checkForUpdate — 第 2 次也走 inFlight 复用，不重复 axios', async () => {
    let resolveAxios!: (value: any) => void
    mockedAxiosGet.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAxios = resolve
      })
    )

    // 启动 2 个并发请求
    const p1 = checkForUpdate()
    const p2 = checkForUpdate()

    // 让 axios resolve
    resolveAxios({
      data: { tag_name: 'v0.2.88', html_url: '...', published_at: '' },
    })

    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.status).toBe('update-available')
    expect(r2.status).toBe('update-available')
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后 checkForUpdate 重新调 axios', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))

    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.88', html_url: '...', published_at: '' },
    })
    await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1)

    // 时间快进 11 分钟（超过 10 分钟 TTL）
    vi.setSystemTime(new Date('2026-07-24T00:11:00Z'))

    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.89', html_url: '...', published_at: '' },
    })
    const result = await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledTimes(2)
    expect(result.latestVersion).toBe('0.2.89')

    vi.useRealTimers()
  })
})

describe('updateChecker — GitHub API 请求参数', () => {
  it('使用正确的 URL 和 headers', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.88', html_url: '...', published_at: '' },
    })
    await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'https://api.github.com/repos/hamlin-zy/hclaw/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'User-Agent': 'HClaw-Updater/0.2.87',
        }),
      })
    )
  })

  it('设置了 5 秒超时', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.88', html_url: '...', published_at: '' },
    })
    await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 5000 })
    )
  })
})

describe('updateChecker — 边界情况', () => {
  it('GitHub 返回的 data 缺字段（如 html_url 缺失）→ 仍能构建 result', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: 'v0.2.88' /* 其他字段缺失 */ },
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('update-available')
    expect(result.downloads.github).toBe('https://github.com/hamlin-zy/hclaw/releases')
    expect(result.downloads.baiduPan).toContain('pan.baidu.com')
    expect(result.releaseNotes).toBe('')
    expect(result.publishedAt).toBe('')
  })

  it('GitHub 返回 tag_name 为空字符串 → graceful up-to-date', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { tag_name: '', html_url: '...', published_at: '' },
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
  })

  it('错误结果也写入缓存 — 避免每次打开关于页面都重试', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
    await checkForUpdate()
    const cached = await getStatus()
    expect(cached?.status).toBe('error')
  })
})