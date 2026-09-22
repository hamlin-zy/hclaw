/**
 * 关于页面「检查更新」核心 service。
 *
 * 职责：
 *   1. 拉取 GitHub raw / Gitee raw 上的 CHANGELOG.json（一次请求同时完成版本判断 + 变更内容）
 *   2. 与当前 app 版本做 semver 比较
 *   3. 维护内存缓存（10 分钟 TTL）+ 并发复用
 *   4. 错误分类（network / rate-limit / parse / unknown）
 *
 * 设计：
 *   - 模块级单例，状态在 cache 常量中
 *   - 不依赖 React、不依赖 Electron IPC（IPC 层在 window.ts 中薄包装）
 *   - 不写本地日志（错误已分类返回，由主进程 logger 记录）
 */

import axios, { AxiosError } from 'axios'
import { app } from 'electron'
import {
  GITHUB_RAW_CHANGELOG_URL,
  GITEE_RAW_CHANGELOG_URL,
  GITHUB_DOWNLOADS_BASE_URL,
  BAIDU_PAN_URL,
  CACHE_TTL_MS,
  REQUEST_TIMEOUT_MS,
} from './constants'
import { compareVersions } from './compareVersions'
import type {
  UpdateResult,
  ChangelogEntry,
  UpdateStatus,
  UpdateSource,
  UpdateError,
} from '../../shared/types/updater'

// ============================================================
// 模块级状态：内存缓存 + 并发复用
// ============================================================

const cache: {
  result: UpdateResult | null
  cachedAt: number
  inFlight: Promise<UpdateResult> | null
} = { result: null, cachedAt: 0, inFlight: null }

// ============================================================
// 公共 API
// ============================================================

/**
 * 启动时调用。异步触发一次静默检查，立即返回 Promise。
 * 不阻塞主窗口显示 — 调用方应 fire-and-forget。
 */
export function init(): Promise<UpdateResult> {
  return checkForUpdate()
}

/**
 * 读取缓存。命中且未过期返回缓存；否则返回 null（调用方应展示「检查更新」按钮）。
 */
export async function getStatus(): Promise<UpdateResult | null> {
  if (cache.result && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.result
  }
  return null
}

/**
 * 强制重检查，绕过 TTL。并发安全：第二次调用复用 inFlight Promise。
 */
export async function checkForUpdate(): Promise<UpdateResult> {
  if (cache.inFlight) return cache.inFlight

  const currentVersion = app.getVersion()
  const promise = doCheck(currentVersion).finally(() => {
    cache.inFlight = null
  })
  cache.inFlight = promise
  return promise
}

// ============================================================
// 内部实现
// ============================================================

/** 归一化版本号：剥离 v 前缀；非字符串一律归一为空串 */
function normalizeVersion(v: unknown): string {
  return typeof v === 'string' ? v.replace(/^v/, '') : ''
}

/** 拉取远程 raw JSON（GitHub raw 与其 Gitee 镜像共用同一请求参数） */
async function fetchRawJson(url: string, currentVersion: string): Promise<unknown> {
  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': `HClaw-Updater/${currentVersion}` },
  })
  return response.data
}

/**
 * 组装 UpdateResult 骨架：downloads / changelog 默认值 / checkedAt 集中填充，
 * github 下载入口 URL 的拼装规则只此一处（指定版本 → 该版本 Release 页，否则 → releases 列表页）。
 * 可选字段仅在显式传入时写入，保持与手写字面量一致的键集。
 */
function buildResult(params: {
  status: UpdateStatus
  currentVersion: string
  now: number
  /** 传入时 github 入口指向该版本的 Release tag 页 */
  githubVersion?: string
  latestVersion?: string
  changelog?: ChangelogEntry[]
  source?: UpdateSource
  error?: UpdateError
}): UpdateResult {
  const result: UpdateResult = {
    status: params.status,
    currentVersion: params.currentVersion,
    downloads: {
      github: params.githubVersion
        ? `${GITHUB_DOWNLOADS_BASE_URL}/releases/tag/v${params.githubVersion}`
        : GITHUB_DOWNLOADS_BASE_URL,
      baiduPan: BAIDU_PAN_URL,
    },
    changelog: params.changelog ?? [],
    checkedAt: params.now,
  }
  if (params.latestVersion !== undefined) result.latestVersion = params.latestVersion
  if (params.source !== undefined) result.source = params.source
  if (params.error !== undefined) result.error = params.error
  return result
}

async function doCheck(currentVersion: string): Promise<UpdateResult> {
  const now = Date.now()
  // GitHub raw 优先，失败兜底 Gitee raw（同一文件镜像）
  try {
    const payload = await fetchRawJson(GITHUB_RAW_CHANGELOG_URL, currentVersion)
    const result = resolveResult(currentVersion, payload, 'github', now)
    cache.result = result
    cache.cachedAt = now
    return result
  } catch (err) {
    const fallback = await checkGiteeFallback(currentVersion, now)
    if (fallback) {
      cache.result = fallback
      cache.cachedAt = now
      return fallback
    }

    const error = classifyError(err)
    const result = buildResult({
      status: 'error',
      currentVersion,
      now,
      error,
    })
    cache.result = result
    cache.cachedAt = now
    return result
  }
}

/**
 * Gitee 兜底：从 Gitee raw 的 CHANGELOG.json 读取版本信息（与 GitHub 同一文件镜像）。
 * 成功返回 UpdateResult（update-available 或 up-to-date），失败返回 null 交回外层错误处理。
 */
async function checkGiteeFallback(
  currentVersion: string,
  now: number
): Promise<UpdateResult | null> {
  try {
    const payload = await fetchRawJson(GITEE_RAW_CHANGELOG_URL, currentVersion)
    return resolveResult(currentVersion, payload, 'gitee', now)
  } catch {
    return null
  }
}

/**
 * 同一份解析逻辑：把 CHANGELOG.json 载荷 + 来源渠道解析为一个成功态 UpdateResult。
 * 仅「非数组」等非法载荷 → 返回 parse 错误结果；空数组、首条非 semver 或 ≤ 当前版本
 * → graceful up-to-date（不算错误）。
 */
function resolveResult(
  currentVersion: string,
  payload: unknown,
  source: 'github' | 'gitee',
  now: number
): UpdateResult {
  const parsed = parseChangelogPayload(payload, currentVersion)
  if (parsed === null) {
    return buildResult({
      status: 'error',
      currentVersion,
      now,
      source,
      error: { code: 'parse', message: '版本信息异常' },
    })
  }
  if (parsed.status === 'up-to-date') {
    // 无新版本：latestVersion 回填当前版本，changelog 为空
    return buildResult({
      status: 'up-to-date',
      currentVersion,
      now,
      latestVersion: currentVersion,
      source,
    })
  }
  return buildResult({
    status: 'update-available',
    currentVersion,
    now,
    githubVersion: parsed.latestVersion,
    latestVersion: parsed.latestVersion,
    changelog: parsed.changelog,
    source,
  })
}

/**
 * 解析 CHANGELOG.json 载荷 → 版本状态。载荷非法返回 null（由调用方按 parse 错误处理）。
 */
export function parseChangelogPayload(
  payload: unknown,
  currentVersion: string
): {
  status: 'update-available' | 'up-to-date'
  latestVersion: string
  changelog: ChangelogEntry[]
} | null {
  // 仅非数组（非法载荷）返回 null（→ parse 错误）；空数组按 graceful up-to-date 处理
  if (!Array.isArray(payload)) return null
  if (payload.length === 0) {
    return {
      status: 'up-to-date',
      latestVersion: currentVersion,
      changelog: [],
    }
  }
  const first = payload[0] as Partial<ChangelogEntry>
  const latestVersion = normalizeVersion(first.version)
  const cmp = compareVersions(latestVersion, currentVersion)
  if (cmp === null || cmp <= 0) {
    return {
      status: 'up-to-date',
      latestVersion: currentVersion,
      changelog: [],
    }
  }
  // 类型谓词须校验完整 ChangelogEntry 形状（Task 4/5 会消费 date/title/items），
  // 另外校验 items 元素均为 string、tag（若存在）为 string：渲染层直接 items.map /
  // 渲染 {tag}，坏 JSON 会在渲染期抛错并被整窗 ErrorBoundary 兜底降级。
  // 不合规条目静默跳过（与 Task 1 生成脚本的校验口径一致），不阻塞、不崩溃。
  const changelog: ChangelogEntry[] = payload.filter(
    (e): e is ChangelogEntry => {
      if (e === null || typeof e !== 'object') return false
      const entry = e as Partial<ChangelogEntry>
      const v = normalizeVersion(entry.version)
      return (
        v !== '' &&
        (compareVersions(v, currentVersion) ?? 0) > 0 &&
        typeof entry.date === 'string' &&
        entry.date !== '' &&
        typeof entry.title === 'string' &&
        entry.title !== '' &&
        Array.isArray(entry.items) &&
        entry.items.length > 0 &&
        entry.items.every((i) => typeof i === 'string') &&
        (entry.tag === undefined || typeof entry.tag === 'string')
      )
    }
  )
  return { status: 'update-available', latestVersion, changelog }
}

/**
 * 错误分类：把 axios 抛出的各种异常归类为 UI 可识别的错误码
 */
function classifyError(err: unknown): UpdateResult['error'] {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError
    const code = axiosErr.code
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'ECONNRESET'
    ) {
      return { code: 'network', message: '网络异常' }
    }
    const status = axiosErr.response?.status
    if (status === 403) {
      // GitHub API 移除后不再触发（raw 不会返回 403 rate-limit），但保留防御已知场景
      const reset = axiosErr.response?.headers?.['x-ratelimit-reset']
      const resetMs = typeof reset === 'string' ? Number(reset) * 1000 : NaN
      const minutes = Number.isFinite(resetMs)
        ? Math.ceil((resetMs - Date.now()) / 60000)
        : 0
      return {
        code: 'rate-limit',
        message:
          minutes > 0 ? `请求频繁，${minutes} 分钟后重试` : '请求频繁，请稍后再试',
      }
    }
    if (status === 404) {
      return { code: 'parse', message: '版本信息异常' }
    }
    return { code: 'unknown', message: '检查失败' }
  }
  return { code: 'unknown', message: '检查失败' }
}

// ============================================================
// 测试钩子（仅供单测使用）
// ============================================================

/** 重置缓存和并发状态 — 仅供单测 */
export function __resetCacheForTesting(): void {
  cache.result = null
  cache.cachedAt = 0
  cache.inFlight = null
}