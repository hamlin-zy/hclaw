/**
 * updateChecker service 单测
 *
 * 版本判断 + 变更内容统一来自 CHANGELOG.json（GitHub raw 优先，Gitee raw 兜底，同一文件镜像）。
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
  parseChangelogPayload,
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

const sampleChangelog = [
  {
    version: 'v0.2.88',
    date: '2026-08-01',
    title: '新功能上线',
    items: ['支持自定义短语', '修复若干问题'],
  },
  {
    version: 'v0.2.87',
    date: '2026-07-30',
    title: '稳定性修复',
    items: ['修复缓存断裂'],
  },
]

const GITHUB_CHANGELOG_URL = 'https://raw.githubusercontent.com/hamlin-zy/hclaw/main/CHANGELOG.json'
const GITEE_CHANGELOG_URL = 'https://gitee.com/sunshao/hclaw/raw/main/CHANGELOG.json'

beforeEach(() => {
  __resetCacheForTesting()
  mockedAxiosGet.mockReset()
  mockedIsAxiosError.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('updateChecker — CHANGELOG.json 主路径', () => {
  it('GitHub raw 返回更高版本 → update-available，changelog 含跨越条目', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog })
    const result = await checkForUpdate()
    expect(result.status).toBe('update-available')
    expect(result.latestVersion).toBe('0.2.88')
    expect(result.changelog).toEqual([
      {
        version: 'v0.2.88',
        date: '2026-08-01',
        title: '新功能上线',
        items: ['支持自定义短语', '修复若干问题'],
      },
    ])
    expect(result.source).toBe('github')
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      GITHUB_CHANGELOG_URL,
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('多方条目都高于当前 → changelog 含全部跨越条目（倒序）', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: [
        { version: 'v0.2.90', date: '2026-08-03', title: '三', items: ['a'] },
        { version: 'v0.2.88', date: '2026-08-01', title: '一', items: ['b'] },
        { version: 'v0.2.87', date: '2026-07-30', title: '旧', items: ['c'] },
      ],
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('update-available')
    expect(result.latestVersion).toBe('0.2.90')
    expect(result.changelog.map((e) => e.version)).toEqual(['v0.2.90', 'v0.2.88'])
  })

  it('首条版本 ≤ 当前版本 → up-to-date，changelog 为 []，latestVersion 填 currentVersion', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog }) // 首条 v0.2.88 > 0.2.87，故构造相反数据
    // 实际用首条 ≤ 当前的数据
    mockedAxiosGet.mockReset()
    mockedAxiosGet.mockResolvedValueOnce({
      data: [
        { version: 'v0.2.87', date: '2026-07-30', title: '稳定性修复', items: ['修复缓存断裂'] },
      ],
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
    expect(result.changelog).toEqual([])
    expect(result.latestVersion).toBe('0.2.87')
    expect(result.source).toBe('github')
  })

  it('首条版本 == 当前版本 → up-to-date（相等）', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: [{ version: 'v0.2.87', date: '2026-07-30', title: 'x', items: [] }],
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
    expect(result.changelog).toEqual([])
  })

  it('首条非 semver → graceful up-to-date', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: [{ version: 'garbage', date: '', title: 'x', items: [] }],
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
    expect(result.latestVersion).toBe('0.2.87')
    expect(result.changelog).toEqual([])
  })

  it('空数组 → graceful up-to-date（空 changelog，latestVersion 填 currentVersion）', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: [] })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
    expect(result.latestVersion).toBe('0.2.87')
    expect(result.changelog).toEqual([])
    expect(result.error).toBeUndefined()
  })

  it('下载 URL = GITHUB_DOWNLOADS_BASE_URL/releases/tag/v${latestVersion}', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog })
    const result = await checkForUpdate()
    expect(result.downloads.github).toBe(
      'https://github.com/hamlin-zy/hclaw/releases/tag/v0.2.88'
    )
    expect(result.downloads.baiduPan).toContain('pan.baidu.com')
  })
})

describe('updateChecker — parseChangelogPayload', () => {
  it('payload 非数组 → null', () => {
    expect(parseChangelogPayload('not-array', '0.2.87')).toBeNull()
    expect(parseChangelogPayload({}, '0.2.87')).toBeNull()
  })

  it('payload 空数组 → graceful up-to-date', () => {
    expect(parseChangelogPayload([], '0.2.87')).toEqual({
      status: 'up-to-date',
      latestVersion: '0.2.87',
      changelog: [],
    })
  })

  it('非法的 JSON 字符串（data 为 string 时非数组）→ null', () => {
    expect(parseChangelogPayload('not-json', '0.2.87')).toBeNull()
  })
})

describe('updateChecker — 错误分类', () => {
  it('JSON 非法（data 非数组）→ error 且 code 为 parse', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: 'not-json' })
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('parse')
    expect(result.changelog).toEqual([])
  })

  it('ECONNREFUSED + Gitee raw 成功（更高版本）→ update-available、source === gitee', async () => {
    mockedAxiosGet
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({ data: sampleChangelog })
    const result = await checkForUpdate()
    expect(result.status).toBe('update-available')
    expect(result.latestVersion).toBe('0.2.88')
    expect(result.source).toBe('gitee')
    expect(result.changelog.length).toBeGreaterThan(0)
    expect(mockedAxiosGet).toHaveBeenLastCalledWith(
      GITEE_CHANGELOG_URL,
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('双渠道失败 → error 且 code 为 network', async () => {
    mockedAxiosGet
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
    expect(result.error?.message).toBe('网络异常')
  })

  it('ECONNREFUSED → network 错误', async () => {
    mockedAxiosGet
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
  })

  it('ETIMEDOUT → network 错误', async () => {
    mockedAxiosGet
      .mockRejectedValueOnce(makeAxiosError({ code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(makeAxiosError({ code: 'ETIMEDOUT' }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
  })

  it('HTTP 403 + X-RateLimit-Reset → rate-limit 错误（带分钟数，GitHub API 移除后不再触发）', async () => {
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
})

describe('updateChecker — Gitee 兜底', () => {
  it('GitHub 失败 + Gitee 版本 ≤ 当前版本 → up-to-date', async () => {
    mockedAxiosGet
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({
        data: [{ version: 'v0.2.87', date: '2026-07-30', title: 'x', items: [] }],
      })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
    expect(result.changelog).toEqual([])
    expect(result.source).toBe('gitee')
  })

  it('GitHub 失败 + Gitee 返回非 semver 版本 → graceful up-to-date', async () => {
    mockedAxiosGet
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({
        data: [{ version: 'garbage', date: '', title: 'x', items: [] }],
      })
    const result = await checkForUpdate()
    expect(result.status).toBe('up-to-date')
  })

  it('GitHub 失败 + Gitee 也失败 → 返回 network 分类', async () => {
    mockedAxiosGet
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
      .mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
    const result = await checkForUpdate()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
  })
})

describe('updateChecker — 缓存行为', () => {
  it('init() 触发首次检查并填充缓存', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog })
    await init()
    const cached = await getStatus()
    expect(cached).not.toBeNull()
    expect(cached?.status).toBe('update-available')
    expect(cached?.changelog.length).toBeGreaterThan(0)
  })

  it('getStatus() 在缓存为空时返回 null', async () => {
    const cached = await getStatus()
    expect(cached).toBeNull()
  })

  it('TTL 内 getStatus 返回缓存，不调 axios', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog })
    await checkForUpdate()
    mockedAxiosGet.mockClear()
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
    const p1 = checkForUpdate()
    const p2 = checkForUpdate()
    resolveAxios({ data: sampleChangelog })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe('update-available')
    expect(r2.status).toBe('update-available')
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后 checkForUpdate 重新调 axios', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))

    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog })
    await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-07-24T00:11:00Z'))

    mockedAxiosGet.mockResolvedValueOnce({
      data: [
        { version: 'v0.2.89', date: '2026-08-02', title: '二', items: ['x'] },
      ],
    })
    const result = await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledTimes(2)
    expect(result.latestVersion).toBe('0.2.89')
  })
})

describe('updateChecker — GitHub raw 请求参数', () => {
  it('使用正确的 URL 和 User-Agent header', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog })
    await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      GITHUB_CHANGELOG_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'HClaw-Updater/0.2.87',
        }),
      })
    )
  })

  it('设置了 5 秒超时', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: sampleChangelog })
    await checkForUpdate()
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 5000 })
    )
  })
})

describe('updateChecker — 边界情况', () => {
  it('changelog 中缺 items 的中间条目 → 被丢弃、不出现、不抛错', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: [
        { version: 'v0.2.90', date: '2026-08-03', title: '三', items: ['c'] },
        { version: 'v0.2.89', date: '2026-08-02', title: '缺 items 的中间条目' },
        { version: 'v0.2.88', date: '2026-08-01', title: '二', items: ['a'] },
      ],
    })
    const result = await checkForUpdate()
    expect(result.status).toBe('update-available')
    expect(result.latestVersion).toBe('0.2.90')
    expect(result.changelog.map((e) => e.version)).toEqual(['v0.2.90', 'v0.2.88'])
    expect(result.changelog.some((e) => e.title === '缺 items 的中间条目')).toBe(false)
    // 每个保留条目的 items 都可安全 map（Task 4/5 消费不崩溃）
    expect(() => result.changelog.forEach((e) => e.items.map((i) => i))).not.toThrow()
  })

  it('changelog 中缺 date/title/items 的条目一律丢弃 → 仅保留完整条目', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: [
        { version: 'v0.2.90', date: '2026-08-03', title: '三', items: ['c'] },
        { version: 'v0.2.89', date: '2026-08-02', title: '缺 items' },
        { version: 'v0.2.88', date: '', title: '空日期', items: ['b'] },
        { version: 'v0.2.87', date: '2026-07-30', title: '', items: ['a'] },
      ],
    })
    const result = await checkForUpdate()
    expect(result.changelog).toEqual([
      { version: 'v0.2.90', date: '2026-08-03', title: '三', items: ['c'] },
    ])
  })

  it('错误结果也写入缓存 — 避免每次打开关于页面都重试', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError({ code: 'ECONNREFUSED' }))
    await checkForUpdate()
    const cached = await getStatus()
    expect(cached?.status).toBe('error')
  })
})