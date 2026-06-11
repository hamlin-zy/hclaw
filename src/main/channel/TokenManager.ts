/**
 * TokenManager — 通用 Token 刷新框架
 *
 * 统一管理所有需要短时效 Token 自动刷新的场景：
 * - 飞书 tenant_access_token（2h 有效期）
 * - Google OAuth2 access_token（1h 有效期）
 *
 * 核心能力：
 * 1. 预主动刷新：过期前自动刷新（可配置提前量）
 * 2. 并发去重：同一 provider 的并发 getToken 只触发一次刷新
 * 3. 持久化回调：刷新后可自动回写 DB
 * 4. 事件通知：外部可通过 onTokenRefreshed / onTokenError 监听
 * 5. 生命周期管理：register / unregister 配对使用
 */

// ─── 内部状态类型 ─────────────────────────────────────

import {logger} from '../agent/logger'

interface ProviderState {
    token: string
    expiryAt: number
    leadTime: number
    refreshFn: () => Promise<{ accessToken: string; expiryDate: number }>
    persistFn?: (token: string, expiry: number) => Promise<void>
    onError?: (err: Error) => void
}

interface PendingRefresh {
    promise: Promise<string>
    timestamp: number
}

// ─── 默认配置 ────────────────────────────────────────────

const DEFAULT_LEAD_TIME_MS = 5 * 60 * 1000 // 默认提前 5 分钟刷新

// ─── TokenProviderConfig ────────────────────────────────

export interface TokenProviderConfig {
    /** 唯一标识，如 'feishu' / 'google-oauth2' */
    providerId: string

    /** Token 刷新函数，返回新 token 和过期时间戳 */
    refreshFn: () => Promise<{ accessToken: string; expiryDate: number }>

    /** 刷新后的持久化回调（如写回 DB），可选 */
    persistFn?: (token: string, expiry: number) => Promise<void>

    /** 提前刷新时间（毫秒），默认 5 分钟 */
    refreshLeadTime?: number

    /** 刷新失败回调 */
    onError?: (err: Error) => void
}

// ─── TokenManager ───────────────────────────────────────

export class TokenManager {
    /** providerId → ProviderState */
    private providers = new Map<string, ProviderState>()
    /** providerId → 定时器句柄 */
    private timers = new Map<string, ReturnType<typeof setTimeout>>()
    /** providerId → 正在进行的刷新操作（防并发） */
    private pendingRefreshes = new Map<string, PendingRefresh>()
    /** providerId → 注册回调列表 */
    private refreshCallbacks = new Map<string, Array<(token: string) => void>>()
    private errorCallbacks = new Map<string, Array<(err: Error) => void>>()

    // ─── 注册与管理 ─────────────────────────────────────

    /**
     * 注册一个 Token 提供者
     *
     * @param config Token 提供者配置
     */
    register(config: TokenProviderConfig): void {
        const { providerId, refreshFn, persistFn, refreshLeadTime, onError } = config
        const leadTime = refreshLeadTime ?? DEFAULT_LEAD_TIME_MS



        this.providers.set(providerId, {
            token: '',
            expiryAt: 0,
            leadTime,
            refreshFn,
            persistFn,
            onError,
        })
    }

    /**
     * 注销一个 Token 提供者
     * 清除定时器并释放状态
     */
    unregister(providerId: string): void {
        logger.info('TokenManager.unregister', { providerId })
        this.clearTimer(providerId)
        this.providers.delete(providerId)
        this.pendingRefreshes.delete(providerId)
        this.refreshCallbacks.delete(providerId)
        this.errorCallbacks.delete(providerId)
    }

    /**
     * 检查 provider 是否已注册
     */
    isRegistered(providerId: string): boolean {
        return this.providers.has(providerId)
    }

    // ─── 核心 API ────────────────────────────────────────

    /**
     * 获取有效 Token
     *
     * - Token 有效期内 → 直接返回缓存的 token
     * - Token 已过期或即将过期 → 自动触发刷新
     * - 多个并发请求同一 provider → 共享同一个刷新 Promise
     *
     * @param providerId 提供者 ID
     * @returns 有效的 access token
     */
    async getToken(providerId: string): Promise<string> {
        const state = this.providers.get(providerId)
        if (!state) {
            throw new Error(`[TokenManager] Provider not registered: ${providerId}`)
        }

        // Token 有效且在 leadTime 之前 → 直接返回
        if (state.token && Date.now() < state.expiryAt - state.leadTime) {
            return state.token
        }

        // Token 已过期或即将过期 → 刷新（复用已有刷新）
        return this.refresh(providerId)
    }

    /**
     * 强制立即刷新 Token
     *
     * @param providerId 提供者 ID
     * @returns 新的 access token
     */
    async refreshNow(providerId: string): Promise<string> {
        return this.refresh(providerId, /* force */ true)
    }

    // ─── 事件监听 ────────────────────────────────────────

    /**
     * 监听 Token 刷新成功事件
     */
    onTokenRefreshed(providerId: string, callback: (token: string) => void): void {
        if (!this.refreshCallbacks.has(providerId)) {
            this.refreshCallbacks.set(providerId, [])
        }
        this.refreshCallbacks.get(providerId)!.push(callback)
    }

    /**
     * 监听 Token 刷新失败事件
     */
    onTokenError(providerId: string, callback: (err: Error) => void): void {
        if (!this.errorCallbacks.has(providerId)) {
            this.errorCallbacks.set(providerId, [])
        }
        this.errorCallbacks.get(providerId)!.push(callback)
    }

    // ─── 内部刷新逻辑 ────────────────────────────────────

    /**
     * 执行刷新（或复用已有刷新）
     */
    private async refresh(providerId: string, force = false): Promise<string> {
        const state = this.providers.get(providerId)
        if (!state) {
            throw new Error(`[TokenManager] Provider not registered: ${providerId}`)
        }

        // 非强制刷新时，检查已有刷新操作
        if (!force) {
            const pending = this.pendingRefreshes.get(providerId)
            if (pending) {
                logger.info('TokenManager.reuseRefresh', { providerId, startedMs: pending.timestamp })
                return pending.promise
            }
        }

        // 创建新的刷新 Promise
        const promise = this.executeRefresh(providerId)
        this.pendingRefreshes.set(providerId, { promise, timestamp: Date.now() })

        try {
            const token = await promise
            return token
        } finally {
            this.pendingRefreshes.delete(providerId)
        }
    }

    /**
     * 执行实际的刷新操作
     */
    private async executeRefresh(providerId: string): Promise<string> {
        const state = this.providers.get(providerId)
        if (!state) {
            throw new Error(`[TokenManager] Provider not registered: ${providerId}`)
        }

        logger.info('TokenManager.refreshToken', { providerId })

        try {
            const result = await state.refreshFn()

            // 更新缓存
            state.token = result.accessToken
            state.expiryAt = result.expiryDate

            logger.info('TokenManager.tokenRefreshed', {
                providerId,
                validUntil: new Date(result.expiryDate).toISOString(),
                tokenPrefix: result.accessToken.slice(0, 10) + '...',
            })

            // 安排下次自动刷新
            this.scheduleNextRefresh(providerId)

            // 持久化回调
            if (state.persistFn) {
                state.persistFn(result.accessToken, result.expiryDate)
                    .catch(err => logger.error('TokenManager.persistFn', { providerId, error: (err as Error)?.message || err }))
            }

            // 触发事件回调
            this.notifyRefreshCallbacks(providerId, result.accessToken)

            return result.accessToken
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            logger.error('TokenManager.refreshFailed', { providerId, error: error.message })

            // 触发错误回调
            state.onError?.(error)
            this.notifyErrorCallbacks(providerId, error)

            // 保留旧 token，尝试在 leadTime 后重试
            if (state.token) {
                this.scheduleNextRefresh(providerId)
            }

            throw error
        }
    }

    /**
     * 安排下次自动刷新
     *
     * 在 expiryAt - leadTime 时触发，如果已过期则立即刷新
     */
    private scheduleNextRefresh(providerId: string): void {
        this.clearTimer(providerId)

        const state = this.providers.get(providerId)
        if (!state || !state.token) return

        const refreshAt = state.expiryAt - state.leadTime
        const delay = Math.max(0, refreshAt - Date.now())

        if (delay <= 0) {
            // 已经过期了，立即刷新
            logger.info('TokenManager.expiredRefresh', { providerId })
            void this.refresh(providerId)
            return
        }

        logger.info('TokenManager.scheduleNext', {
            providerId,
            delaySec: Math.round(delay / 1000),
            refreshAt: new Date(refreshAt).toISOString(),
        })

        const timer = setTimeout(() => {
            logger.info('TokenManager.scheduleTriggered', { providerId })
            this.refresh(providerId).catch(err => {
                logger.error('TokenManager.scheduleFailed', { providerId, error: (err as Error)?.message || err })
            })
        }, delay)

        this.timers.set(providerId, timer)
    }

    /**
     * 清除定时器
     */
    private clearTimer(providerId: string): void {
        const timer = this.timers.get(providerId)
        if (timer) {
            clearTimeout(timer)
            this.timers.delete(providerId)
        }
    }

    // ─── 事件通知 ────────────────────────────────────────

    private notifyRefreshCallbacks(providerId: string, token: string): void {
        const callbacks = this.refreshCallbacks.get(providerId)
        if (callbacks) {
            for (const cb of callbacks) {
                try { cb(token) } catch { /* 忽略单个回调异常 */ }
            }
        }
    }

    private notifyErrorCallbacks(providerId: string, err: Error): void {
        const callbacks = this.errorCallbacks.get(providerId)
        if (callbacks) {
            for (const cb of callbacks) {
                try { cb(err) } catch { /* 忽略单个回调异常 */ }
            }
        }
    }

    // ─── 调试信息 ─────────────────────────────────────────

    /**
     * 获取所有 provider 的当前状态（调试用）
     */
    getDebugInfo(): Array<{
        providerId: string
        hasToken: boolean
        expiryLeft: number | null
        hasTimer: boolean
        hasPendingRefresh: boolean
    }> {
        const info: Array<{
            providerId: string
            hasToken: boolean
            expiryLeft: number | null
            hasTimer: boolean
            hasPendingRefresh: boolean
        }> = []
        for (const [providerId, state] of this.providers) {
            const expiryLeft = state.token ? Math.round((state.expiryAt - Date.now()) / 1000) : null
            info.push({
                providerId,
                hasToken: !!state.token,
                expiryLeft,
                hasTimer: this.timers.has(providerId),
                hasPendingRefresh: this.pendingRefreshes.has(providerId),
            })
        }
        return info
    }
}

// ─── 单例导出 ──────────────────────────────────────────

/** 全局 TokenManager 单例 */
export const tokenManager = new TokenManager()
