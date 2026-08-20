import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {ExchangeRateRegistry} from '@/main/exchangeRateRegistry'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exchange-rate-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

/** 构造 currency-api usd.min.json 响应 */
function usdResponse(cny: number): string {
  return JSON.stringify({date: '2026-08-20', usd: {cny, eur: 0.85}})
}

function okFetch(body: string): typeof fetch {
  const fn = (async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  })) as unknown as typeof fetch
  return fn
}

describe('ExchangeRateRegistry', () => {
  it('refresh 成功：getUsdCnyRate 返回实时汇率 + getDate 返回数据日期', async () => {
    const fetchFn = okFetch(usdResponse(6.725761)) as typeof fetch
    const reg = new ExchangeRateRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()

    expect(reg.getUsdCnyRate()).toBe(6.725761)
    expect(reg.getDate()).toBe('2026-08-20')
  })

  it('refresh 失败保留旧数据（先成功后失败）', async () => {
    let fail = false
    const fetchFn = (async () => {
      if (fail) throw new Error('network down')
      return {ok: true, status: 200, text: async () => usdResponse(6.7)}
    }) as unknown as typeof fetch

    const reg = new ExchangeRateRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getUsdCnyRate()).toBe(6.7)

    // 第二次失败：保留旧汇率
    fail = true
    await reg.refresh()
    expect(reg.getUsdCnyRate()).toBe(6.7)
    expect(reg.getDate()).toBe('2026-08-20')
  })

  it('无缓存 + 首次 refresh 失败 → 回退默认汇率 7.2', async () => {
    const fetchFn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const reg = new ExchangeRateRegistry({cacheDir: tmpDir, fetchFn})
    await reg.init()
    expect(reg.getUsdCnyRate()).toBe(7.2)
    expect(reg.getDate()).toBeNull()
  })

  it('HTTP 非 2xx → 视为失败，保留旧数据', async () => {
    const fetchFn = (async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    })) as unknown as typeof fetch
    const reg = new ExchangeRateRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getUsdCnyRate()).toBe(7.2)
  })

  it('init 读缓存立即生效（不依赖网络）', async () => {
    // 预写缓存文件
    fs.mkdirSync(tmpDir, {recursive: true})
    fs.writeFileSync(
      path.join(tmpDir, 'usd.json'),
      JSON.stringify({fetchedAt: Date.now(), data: {date: '2026-08-19', rates: {cny: 6.8}}}),
    )

    const reg = new ExchangeRateRegistry({
      cacheDir: tmpDir,
      fetchFn: (async () => {
        throw new Error('should keep cache value when fetch fails')
      }) as unknown as typeof fetch,
    })
    await reg.init()
    expect(reg.getUsdCnyRate()).toBe(6.8)
    expect(reg.getDate()).toBe('2026-08-19')
  })

  it('缓存文件损坏 / cny 非法 → 忽略缓存，等 refresh 后生效', async () => {
    fs.mkdirSync(tmpDir, {recursive: true})
    fs.writeFileSync(path.join(tmpDir, 'usd.json'), 'not json')
    let called = false
    const fetchFn = (async () => {
      called = true
      return {ok: true, status: 200, text: async () => usdResponse(6.725761)}
    }) as unknown as typeof fetch

    const reg = new ExchangeRateRegistry({cacheDir: tmpDir, fetchFn})
    await reg.init()
    // init 不等待后台 refresh（不阻塞启动）；await refresh 复用同一 promise 等其完成
    await reg.refresh()
    expect(called).toBe(true)
    expect(reg.getUsdCnyRate()).toBe(6.725761)
  })

  it('refresh 防并发：并发调用只 fetch 一次', async () => {
    let fetchCount = 0
    const fetchFn = (async () => {
      fetchCount += 1
      await new Promise((r) => setTimeout(r, 20))
      return {ok: true, status: 200, text: async () => usdResponse(6.9)}
    }) as unknown as typeof fetch

    const reg = new ExchangeRateRegistry({cacheDir: tmpDir, fetchFn})
    await Promise.all([reg.refresh(), reg.refresh(), reg.refresh()])
    expect(fetchCount).toBe(1)
    expect(reg.getUsdCnyRate()).toBe(6.9)
  })

  it('ensureLoaded：已有数据直接返回，不触发 fetch', async () => {
    const fetchFn = vi.fn(okFetch(usdResponse(6.7)) as unknown as typeof fetch)
    const reg = new ExchangeRateRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await reg.ensureLoaded()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
