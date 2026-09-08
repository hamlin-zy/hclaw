/**
 * hclaw_db_query 专用只读连接管理器（全局单例）
 *
 * 设计要点（spec §6.1）：
 * - 不复用读写主连接，独立 readOnly 连接
 * - 启动预热 / 用户启停钩子 / 运行时自愈
 * - 全局锁 + 二次检查，防并发重复建连
 */
import {DatabaseSync, type DatabaseSyncInstance} from '@photostructure/sqlite'
import {logger} from '../../logger'
import {getDatabaseFilePath} from '../../../repositories/sqlite/index'
import {toolRepo} from '../../../repositories/sqlite/toolRepository'

export const HCLAW_DB_QUERY_TOOL_ID = 'hclaw_db_query'

let conn: DatabaseSyncInstance | null = null
// 全局互斥锁：promise 链式串行化建连临界区
let chain: Promise<unknown> = Promise.resolve()

function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = chain.then(fn)
    chain = run.then(() => undefined, () => undefined)
    return run
}

function createReadOnlyConnection(): DatabaseSyncInstance {
    return new DatabaseSync(getDatabaseFilePath(), {readOnly: true})
}

/** 健康检查：连接存在且能执行探针查询 */
function isHealthy(c: DatabaseSyncInstance | null): boolean {
    if (!c) return false
    try {
        c.prepare('SELECT 1').get()
        return true
    } catch {
        return false
    }
}

/** 获取可用连接；不可用时进锁重建（锁内二次检查） */
export function ensureConnection(): DatabaseSyncInstance | Promise<DatabaseSyncInstance> {
    if (isHealthy(conn)) return conn!
    return withLock(() => {
        // 二次检查：等待锁期间可能已被其他调用重建
        if (isHealthy(conn)) return conn!
        // 重建：先关旧句柄，建好后才写入单例（失败不留半初始化状态）
        if (conn) { try { conn.close() } catch { /* ignore */ } conn = null }
        const c = createReadOnlyConnection()
        conn = c
        logger.info('[HclawDbQueryConnection] read-only connection created')
        return c
    })
}

/** 关闭并置空单例（幂等） */
export function closeConnection(): void {
    if (conn) {
        try { conn.close() } catch { /* ignore */ }
        conn = null
        logger.info('[HclawDbQueryConnection] read-only connection closed')
    }
}

export function isReady(): boolean {
    return isHealthy(conn)
}

/** 启动预热：工具启用时立即建连，避免首次调用冷启动 */
export function initHclawDbQueryConnection(): void {
    try {
        if (toolRepo.isEnabled(HCLAW_DB_QUERY_TOOL_ID)) {
            // 预热为 fire-and-forget，但必须兜住 rejection，避免 unhandled rejection 使进程崩溃
            Promise.resolve(ensureConnection()).catch((err: unknown) => {
                logger.warn('[HclawDbQueryConnection] prewarm failed', {error: err})
            })
        }
    } catch (err) {
        logger.warn('[HclawDbQueryConnection] init failed', {error: err})
    }
}

/**
 * 执行只读查询。连接不可用时自动重建并重试一次。
 * 写语句由 readOnly 引擎层兜底抛错。
 */
export async function queryReadOnly(sql: string): Promise<Record<string, unknown>[]> {
    const c = await ensureConnection()
    try {
        return c.prepare(sql).all() as Record<string, unknown>[]
    } catch (err) {
        // 先探测连接健康：SQL 错误（语法错/表不存在等）不应触发重建，
        // 避免误关其他调用方正持有的健康句柄。仅连接确实不健康时才走自愈路径。
        if (isHealthy(c)) throw err
        // 自愈：关旧句柄，锁内重建，重试一次
        closeConnection()
        const fresh = await ensureConnection()
        try {
            return fresh.prepare(sql).all() as Record<string, unknown>[]
        } catch (retryErr) {
            closeConnection() // 重试仍失败：不留坏连接
            throw retryErr
        }
    }
}
