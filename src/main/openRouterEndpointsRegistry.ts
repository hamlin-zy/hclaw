/**
 * OpenRouter 模型「可用服务商列表」注册表（主进程全局单例，对齐 ModelMetaRegistry 模式）
 *
 * - 数据源：GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints（公开接口，无需 apiKey）
 * - 内存 Map：baseModelSlug(modelId) → {fetchedAt, providers}
 * - JSON 缓存：~/.hclaw/model-meta/or-endpoints.json（与 or-models.json 同目录，可注入 cacheDir 覆盖）
 *   结构：{ [modelId: string]: { fetchedAt: number; providers: OpenRouterProviderOption[] } }
 * - 查询：内存命中 → 读盘命中 → fetch；同一 modelId 并发合并（inflight 复用，force 请求独立合并不复用旧请求）
 * - 降级：失败静默返回 {fetchedAt: 0, providers: []}，不抛错、不破坏已有缓存
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  baseModelSlug,
  parseModelEndpoints,
  type OpenRouterProviderOption,
} from '@shared/openRouterProviders'
import {createLogger} from './agent/logger'

const logger = createLogger('OpenRouterEndpointsRegistry')

const OR_ENDPOINTS_BASE = 'https://openrouter.ai/api/v1/models'

export interface OpenRouterEndpointsResult {
  fetchedAt: number
  providers: OpenRouterProviderOption[]
}

export interface OpenRouterEndpointsRegistryOptions {
  cacheDir?: string
  fetchFn?: typeof fetch
}

/** 空结果（失败 / 未命中降级；每次返回新对象，避免调用方共享可变引用） */
function emptyResult(): OpenRouterEndpointsResult {
  return {fetchedAt: 0, providers: []}
}

/** 结果浅拷贝：内存/盘命中的条目是注册表内部对象，不可直接外泄（否则调用方改动会污染缓存） */
function cloneResult(r: OpenRouterEndpointsResult): OpenRouterEndpointsResult {
  return {fetchedAt: r.fetchedAt, providers: [...r.providers]}
}

/** 响应结构守卫：data 存在且 endpoints 为数组（合法空数组也算有效响应，照常缓存） */
function isEndpointsPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const data = (raw as {data?: unknown}).data
  return !!data && typeof data === 'object' && Array.isArray((data as {endpoints?: unknown}).endpoints)
}

export class OpenRouterEndpointsRegistry {
  private readonly memory = new Map<string, OpenRouterEndpointsResult>()
  private readonly inflight = new Map<string, Promise<OpenRouterEndpointsResult>>()
  private diskLoaded = false
  private readonly cacheDir: string
  private readonly cacheFile: string
  private readonly fetchFn: typeof fetch

  constructor(opts: OpenRouterEndpointsRegistryOptions = {}) {
    this.cacheDir = opts.cacheDir ?? path.join(os.homedir(), '.hclaw', 'model-meta')
    this.cacheFile = path.join(this.cacheDir, 'or-endpoints.json')
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** 查询某模型的可用服务商列表；失败 / 未命中 → {fetchedAt: 0, providers: []}（不抛） */
  async getModelEndpoints(modelId: string, force = false): Promise<OpenRouterEndpointsResult> {
    const key = baseModelSlug(modelId)
    if (!key) return emptyResult()

    if (!force) {
      const mem = this.memory.get(key)
      if (mem) return cloneResult(mem)
      this.loadFromCache()
      const fromDisk = this.memory.get(key)
      if (fromDisk) return cloneResult(fromDisk)
    }

    // 并发合并：同一 modelId 只发一次网络请求。
    // force 请求使用独立合并键：否则「刷新」会复用进行中的普通请求，拿到刷新前的旧结果。
    // （写盘为同步 read-modify-write 且合并 this.memory，两个键的结果最终都落盘，无竞态窗口）
    const pendingKey = force ? `${key}\u0000force` : key
    const pending = this.inflight.get(pendingKey)
    if (pending) return pending
    const task = this.fetchAndCache(key).finally(() => {
      this.inflight.delete(pendingKey)
    })
    this.inflight.set(pendingKey, task)
    return task
  }

  private async fetchAndCache(key: string): Promise<OpenRouterEndpointsResult> {
    try {
      const url = `${OR_ENDPOINTS_BASE}/${key}/endpoints`
      const res = await this.fetchFn(url, {signal: AbortSignal.timeout(15000)})
      if (!res.ok) throw new Error(`OpenRouter /endpoints HTTP ${res.status}`)
      const raw: unknown = JSON.parse(await res.text())
      if (!isEndpointsPayload(raw)) throw new Error('OpenRouter /endpoints 解析为空')

      const result: OpenRouterEndpointsResult = {fetchedAt: Date.now(), providers: parseModelEndpoints(raw)}
      this.memory.set(key, result)
      this.writeCache()
      logger.info('[OpenRouterEndpointsRegistry] fetched', {model: key, count: result.providers.length})
      return cloneResult(result)
    } catch (err) {
      logger.warn('[OpenRouterEndpointsRegistry] fetch failed, keep existing data', {model: key, error: String(err)})
      return emptyResult()
    }
  }

  /** 读盘（一次性，懒加载）；无缓存 / 损坏 → 忽略，等 fetch */
  private loadFromCache(): void {
    if (this.diskLoaded) return
    this.diskLoaded = true
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue
        const entry = v as {fetchedAt?: unknown; providers?: unknown}
        if (typeof entry.fetchedAt !== 'number' || !Array.isArray(entry.providers)) continue
        this.memory.set(k, {
          fetchedAt: entry.fetchedAt,
          providers: entry.providers as OpenRouterProviderOption[],
        })
      }
    } catch {
      // 无缓存 / 损坏 → 等 fetch
    }
  }

  /** 写盘：与磁盘现有内容合并（避免覆盖其它 modelId 的既有条目） */
  private writeCache(): void {
    try {
      fs.mkdirSync(this.cacheDir, {recursive: true})
      const merged: Record<string, OpenRouterEndpointsResult> = {}
      try {
        const existing: unknown = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
        if (existing && typeof existing === 'object') Object.assign(merged, existing)
      } catch {
        // 无文件 / 损坏 → 从空开始
      }
      for (const [k, v] of this.memory) merged[k] = v
      fs.writeFileSync(this.cacheFile, JSON.stringify(merged))
    } catch (err) {
      logger.warn('[OpenRouterEndpointsRegistry] write cache failed', {error: String(err)})
    }
  }
}

/** 全局单例（消费方统一从此处获取，避免频繁读盘） */
export const openRouterEndpointsRegistry = new OpenRouterEndpointsRegistry()
