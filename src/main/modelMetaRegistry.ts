/**
 * OpenRouter 模型元数据注册表（主进程全局单例）
 *
 * - 内存单份：models 原始列表 + index（normalize(id) → 条目，O(1) 查询）
 * - JSON 缓存：~/.hclaw/model-meta/or-models.json（可注入 cacheDir 覆盖）
 * - init：读缓存立即生效 → 后台 refresh（不阻塞启动）
 * - refresh：fetch OpenRouter /api/v1/models → 更新内存 + 写盘；失败保留旧数据
 * - 降级：无缓存且首刷失败 → 空表，查询返回全 0
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isOpenRouterModel,
  matchOpenRouterModel,
  normalizeModelId,
  parseOpenRouterModels,
  type ModelMeta,
  type OpenRouterModelRaw,
} from '@shared/modelMeta'
import {createLogger} from './agent/logger'

const logger = createLogger('ModelMetaRegistry')

const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export interface ModelMetaRegistryOptions {
  cacheDir?: string
  fetchFn?: typeof fetch
}

export class ModelMetaRegistry {
  private models: OpenRouterModelRaw[] = []
  private index = new Map<string, OpenRouterModelRaw>()
  private fetchedAt = 0
  private refreshPromise: Promise<void> | null = null
  private readonly cacheDir: string
  private readonly cacheFile: string
  private readonly fetchFn: typeof fetch

  constructor(opts: ModelMetaRegistryOptions = {}) {
    this.cacheDir = opts.cacheDir ?? path.join(os.homedir(), '.hclaw', 'model-meta')
    this.cacheFile = path.join(this.cacheDir, 'or-models.json')
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

  /** 索引精确查 + 匹配器兜底；未命中返回全 0 */
  getMeta(modelId: string): ModelMeta {
    const raw = this.lookup(modelId)
    if (!raw) return {contextLength: 0, inputPrice: 0, outputPrice: 0, cacheReadPrice: 0}

    const contextLength = raw.context_length ?? raw.top_provider?.context_length ?? 0
    return {
      contextLength,
      inputPrice: toPrice(raw.pricing?.prompt),
      outputPrice: toPrice(raw.pricing?.completion),
      cacheReadPrice: toPrice(raw.pricing?.input_cache_read),
    }
  }

  getContextLength(modelId: string): number {
    return this.getMeta(modelId).contextLength
  }

  /** 确保元数据已就绪：有数据直接返回；空则等待一次 refresh（防并发，失败保留空表） */
  async ensureLoaded(): Promise<void> {
    if (this.models.length > 0) return
    await this.refresh()
  }

  private lookup(modelId: string): OpenRouterModelRaw | null {
    if (typeof modelId !== 'string') return null
    const q = normalizeModelId(modelId)
    if (!q) return null
    const exact = this.index.get(q)
    if (exact) return exact
    return matchOpenRouterModel(modelId, this.models)
  }

  private async doRefresh(): Promise<void> {
    try {
      const res = await this.fetchFn(OR_MODELS_URL, {signal: AbortSignal.timeout(15000)})
      if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`)
      const text = await res.text()
      const models = parseOpenRouterModels(text)
      if (models.length === 0) throw new Error('OpenRouter /models 解析为空')

      this.fetchedAt = Date.now()
      this.commit(models)
      this.writeCache()
      logger.info('[ModelMetaRegistry] refreshed', {count: this.models.length})
    } catch (err) {
      logger.warn('[ModelMetaRegistry] refresh failed, keep existing data', {error: String(err)})
    }
  }

  private loadFromCache(): void {
    try {
      const raw = fs.readFileSync(this.cacheFile, 'utf8')
      const parsed = JSON.parse(raw) as {fetchedAt?: number; models?: OpenRouterModelRaw[]}
      if (Array.isArray(parsed.models) && parsed.models.length > 0) {
        this.fetchedAt = parsed.fetchedAt ?? 0
        this.commit(parsed.models)
        logger.info('[ModelMetaRegistry] loaded from cache', {count: this.models.length})
      }
    } catch {
      // 无缓存 / 损坏 → 空表，等 refresh
    }
  }

  /** 原子提交：过滤非法条目 → 一次性替换 models + index（坏数据不污染内存） */
  private commit(models: OpenRouterModelRaw[]): void {
    const valid: OpenRouterModelRaw[] = []
    const idx = new Map<string, OpenRouterModelRaw>()
    for (const m of models) {
      if (!isOpenRouterModel(m)) continue  // 跳过缺 id / 非法条目
      valid.push(m)
      const key = normalizeModelId(m.id)
      if (key) idx.set(key, m)
    }
    this.models = valid
    this.index = idx
  }

  private writeCache(): void {
    try {
      fs.mkdirSync(this.cacheDir, {recursive: true})
      fs.writeFileSync(this.cacheFile, JSON.stringify({fetchedAt: this.fetchedAt, models: this.models}))
    } catch (err) {
      logger.warn('[ModelMetaRegistry] write cache failed', {error: String(err)})
    }
  }
}

/** 价格字段转 number：非法值 / NaN / 负数 → 0 */
function toPrice(v?: string | number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 全局单例（消费方统一从此处获取，避免频繁读盘） */
export const modelMetaRegistry = new ModelMetaRegistry()
