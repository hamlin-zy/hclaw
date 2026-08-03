import * as path from 'path'
import * as fs from 'fs'
import {DatabaseSync, enhance} from '@photostructure/sqlite'
import {getHclawDir} from '../../config'

type EnhancedDB = ReturnType<typeof enhance>

let db: EnhancedDB | null = null
let initialized = false
let migrationsRun = false

const DB_DIR = path.join(getHclawDir(), 'data')
const DB_FILE = path.join(DB_DIR, 'hclaw.db')

function ensureInitialized(): void {
    if (initialized) return
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, {recursive: true})
    try {
        db = enhance(new DatabaseSync(DB_FILE))
        db.pragma('journal_mode = WAL')
        db.pragma('busy_timeout = 5000')
        initialized = true
    } catch (err) {
        throw new Error(`Database initialization failed: ${err}`)
    }
}

export function getDatabase(): EnhancedDB {
    ensureInitialized()
    return db!
}

export function initDatabaseSync(): void {
    if (migrationsRun) return
    ensureInitialized()
    runMigrations()
    migrationsRun = true
}

// ── 低频 WAL checkpoint ────────────────────────────────────────────
// 性能优化：WAL 模式下事务提交即持久（数据在 WAL 文件中），断电恢复不依赖 checkpoint。
// 高频 checkpoint(TRUNCATE) 会把整个 WAL 合并回主库文件（374MB 库可达数百 ms），
// 且同步阻塞 main 进程事件循环，是流式响应期间 UI 卡顿的主因之一。
// 改为：防抖合并 + 周期兜底 + 超阈值强制，仅在需要时 checkpoint。
//
// 注意：仍保留周期兜底，避免 WAL 无限增长；退出时 flushDatabase() 强制 checkpoint。

const WAL_CHECKPOINT_DEBOUNCE_MS = 10_000      // 距上次 checkpoint 后 ≥10s 才再次检查
const WAL_CHECKPOINT_INTERVAL_MS = 30_000      // 周期兜底：每 30s 检查一次
const WAL_CHECKPOINT_BYTES_THRESHOLD = 64 * 1024 * 1024  // WAL 超过 64MB 强制 checkpoint

let lastCheckpointAt = 0
let checkpointTimer: NodeJS.Timeout | null = null

function walFileSize(): number {
    try {
        return fs.statSync(DB_FILE + '-wal').size
    } catch {
        return 0
    }
}

function tryCheckpoint(force: boolean): boolean {
    if (!db) return false
    try {
        if (!force) {
            // 防抖：距上次检查不足窗口则跳过（每次 saveDatabase 都会进这里，必须廉价）
            if (Date.now() - lastCheckpointAt < WAL_CHECKPOINT_DEBOUNCE_MS) return false
            lastCheckpointAt = Date.now()
            // 阈值：WAL 未超阈值则跳过，避免频繁全量合并
            if (walFileSize() < WAL_CHECKPOINT_BYTES_THRESHOLD) return false
        }
        db.pragma('wal_checkpoint(TRUNCATE)')
        lastCheckpointAt = Date.now()
        return true
    } catch {
        return false
    }
}

function schedulePeriodicCheckpoint(): void {
    if (checkpointTimer) return
    checkpointTimer = setTimeout(() => {
        checkpointTimer = null
        tryCheckpoint(false)
    }, WAL_CHECKPOINT_INTERVAL_MS)
    if (typeof checkpointTimer.unref === 'function') checkpointTimer.unref()
}

/**
 * 标记数据库有写入，安排低频 checkpoint（防抖 + 周期兜底 + 超阈值强制）。
 * 在事务提交后调用；WAL 文件自动保证断电恢复，无需每次同步合并主库。
 * 高频调用时内部仅做 Date.now() 比较（<1μs），不阻塞事件循环。
 */
export function saveDatabase(): void {
    if (!db) return
    schedulePeriodicCheckpoint()
    tryCheckpoint(false)
}

/** 退出时强制 checkpoint，把 WAL 合并回主库并截断（应用正常退出路径） */
export function flushDatabase(): void {
    if (checkpointTimer) {
        clearTimeout(checkpointTimer)
        checkpointTimer = null
    }
    tryCheckpoint(true)
}

export function closeDatabase(): void {
    if (db) {
        flushDatabase()
        db.close();
        db = null;
        initialized = false
    }
}

/**
 * 运行数据库迁移
 *
 * 简化说明：
 * - 使用 CREATE TABLE IF NOT EXISTS 替代首次迁移的特殊处理（-20 行）
 * - 统一所有迁移的执行流程
 * - 移除不必要的 try-catch（CREATE TABLE 原子操作无需预检查）
 */
export function runMigrations(): void {
    if (!db) throw new Error('runMigrations: db is null!')

    // 查找迁移目录（支持打包模式和生产模式两种路径）
    const migrationsDir = resolveMigrationsDir()
    if (!migrationsDir) throw new Error('Migrations directory not found')

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort()

    if (files.length === 0) return

    // 确保迁移跟踪表存在（一行解决，无需首次迁移特殊处理）
    db.exec(`CREATE TABLE IF NOT EXISTS migrations
             (
                 name
                 TEXT
                 PRIMARY
                 KEY,
                 executed_at
                 INTEGER
                 NOT
                 NULL
             )`)

    // 获取已执行的迁移列表
    const executedSet = new Set(
        (db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map(r => r.name)
    )

    // 执行所有未执行的迁移
    const insertStmt = db.prepare('INSERT INTO migrations (name, executed_at) VALUES (?, ?)')
    for (const file of files) {
        if (executedSet.has(file)) continue
        db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'))
        insertStmt.run(file, Date.now())
    }
}

/** 查找迁移文件目录（支持打包和生产两种路径） */
function resolveMigrationsDir(): string | null {
    const candidates = [
        path.join(__dirname, 'repositories', 'sqlite', 'migrations'),
        path.join(__dirname, '..', '..', 'repositories', 'sqlite', 'migrations'),
    ]
    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir
    }
    return null
}
