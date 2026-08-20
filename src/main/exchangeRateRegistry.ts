/**
 * 美元汇率注册表（主进程全局单例，对齐 ModelMetaRegistry 模式）
 *
 * - 内存单份：ExchangeRateData（date + rates 表）
 * - JSON 缓存：~/.hclaw/exchange-rate/usd.json（可注入 cacheDir 覆盖）
 * - init：读缓存立即生效 → 后台 refresh（不阻塞启动）
 * - refresh：fetch currency-api usd.min.json → 更新内存 + 写盘；失败保留旧数据
 * - 降级：无缓存且首刷失败 → getUsdCnyRate 返回 DEFAULT_USD_CNY_RATE（7.2）
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DEFAULT_USD_CNY_RATE,
  getRate,
  parseExchangeRates,
  type ExchangeRateData,
} from '@shared/exchangeRate'
import {createLogger} from './agent/logger'

const logger = createLogger('ExchangeRateRegistry')

const EXCHANGE_RATE_URL = 'https://fastly.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json'

export interface ExchangeRateRegistryOptions {
  cacheDir?: string
  fetchFn?: typeof fetch
}

export class ExchangeRateRegistry {
  private data: ExchangeRateData | null = null
  private fetchedAt = 0
  private refreshPromise: Promise<void> | null = null
  private readonly cacheDir: string
  private readonly cacheFile: string
  private readonly fetchFn: typeof fetch

  constructor(opts: ExchangeRateRegistryOptions = {}) {
    this.cacheDir = opts.cacheDir ?? path.join(os.homedir(), '.hclaw', 'exchange-rate')
    this.cacheFile = path.join(this.cacheDir, 'usd.json')
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** 读缓存（同步生效）→ 后台 refresh（不阻塞启动） */
  async init(): Promise<void> {
    this.loadFromCache()
    void this.refresh()
  }

  /** 拉取并更新；防并发（refreshPromise 复用）；失败保留旧数据 */
  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /** 当前 USD→CNY 汇率；未同步 / 无缓存 → DEFAULT_USD_CNY_RATE（7.2 兜底） */
  getUsdCnyRate(): number {
    if (!this.data) return DEFAULT_USD_CNY_RATE
    return getRate(this.data, 'cny') || DEFAULT_USD_CNY_RATE
  }

  /** 汇率数据日期（YYYY-MM-DD）；无数据 → null */
  getDate(): string | null {
    return this.data?.date ?? null
  }

  /** 确保汇率已就绪：有数据直接返回；空则等待一次 refresh（防并发，失败保留默认值） */
  async ensureLoaded(): Promise<void> {
    if (this.data) return
    await this.refresh()
  }

  private async doRefresh(): Promise<void> {
    try {
      const res = await this.fetchFn(EXCHANGE_RATE_URL, {signal: AbortSignal.timeout(15000)})
      if (!res.ok) throw new Error(`Exchange rate HTTP ${res.status}`)
      const text = await res.text()
      const data = parseExchangeRates(text)
      if (!data) throw new Error('Exchange rate 解析为空')

      this.fetchedAt = Date.now()
      this.data = data
      this.writeCache()
      logger.info('[ExchangeRateRegistry] refreshed', {date: data.date, cny: getRate(data, 'cny')})
    } catch (err) {
      logger.warn('[ExchangeRateRegistry] refresh failed, keep existing data', {error: String(err)})
    }
  }

  private loadFromCache(): void {
    try {
      const raw = fs.readFileSync(this.cacheFile, 'utf8')
      const parsed = JSON.parse(raw) as {fetchedAt?: number; data?: ExchangeRateData}
      if (parsed.data && getRate(parsed.data, 'cny') > 0) {
        this.fetchedAt = parsed.fetchedAt ?? 0
        this.data = parsed.data
        logger.info('[ExchangeRateRegistry] loaded from cache', {date: parsed.data.date})
      }
    } catch {
      // 无缓存 / 损坏 → 默认值，等 refresh
    }
  }

  private writeCache(): void {
    try {
      fs.mkdirSync(this.cacheDir, {recursive: true})
      fs.writeFileSync(this.cacheFile, JSON.stringify({fetchedAt: this.fetchedAt, data: this.data}))
    } catch (err) {
      logger.warn('[ExchangeRateRegistry] write cache failed', {error: String(err)})
    }
  }
}

/** 全局单例（消费方统一从此处获取，避免频繁读盘） */
export const exchangeRateRegistry = new ExchangeRateRegistry()
