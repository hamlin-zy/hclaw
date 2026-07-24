/**
 * 关于页面「检查更新」核心 service。
 *
 * 职责：
 *   1. 调用 GitHub Releases API 获取最新稳定版
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
  GITHUB_API_BASE,
  GITHUB_REPO,
  BAIDU_PAN_URL,
  CACHE_TTL_MS,
  REQUEST_TIMEOUT_MS,
} from './constants'
import { compareVersions } from './compareVersions'
import type { UpdateResult } from '../../shared/types/updater'

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

async function doCheck(currentVersion: string): Promise<UpdateResult> {
  const now = Date.now()
  try {
    const response = await axios.get(
      `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `HClaw-Updater/${currentVersion}`,
        },
      }
    )

    const tagName: string = response.data?.tag_name ?? ''
    const latestVersion = tagName.replace(/^v/, '')
    const cmp = compareVersions(latestVersion, currentVersion)

    // 无法解析最新版本号（如 GitHub 返回了非 semver tag）→ graceful 降级为 up-to-date
    if (cmp === null) {
      return buildUpToDateResult(currentVersion, now)
    }

    const result: UpdateResult =
      cmp > 0
        ? {
            status: 'update-available',
            currentVersion,
            latestVersion,
            releaseNotes: response.data?.body ?? '',
            publishedAt: response.data?.published_at ?? '',
            downloads: {
              github:
                response.data?.html_url ?? `https://github.com/${GITHUB_REPO}/releases`,
              baiduPan: BAIDU_PAN_URL,
            },
            checkedAt: now,
          }
        : buildUpToDateResult(currentVersion, now)

    cache.result = result
    cache.cachedAt = now
    return result
  } catch (err) {
    const error = classifyError(err)
    const result: UpdateResult = {
      status: 'error',
      currentVersion,
      downloads: { github: '', baiduPan: BAIDU_PAN_URL },
      error,
      checkedAt: now,
    }
    cache.result = result
    cache.cachedAt = now
    return result
  }
}

function buildUpToDateResult(currentVersion: string, now: number): UpdateResult {
  return {
    status: 'up-to-date',
    currentVersion,
    latestVersion: currentVersion,
    downloads: { github: '', baiduPan: BAIDU_PAN_URL },
    checkedAt: now,
  }
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
      // GitHub 限流：从 X-RateLimit-Reset header 推断等待时间
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