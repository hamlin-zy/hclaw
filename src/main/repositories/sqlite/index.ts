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

export function saveDatabase(): void {
    if (db) db.pragma('wal_checkpoint(TRUNCATE)')
}

export function closeDatabase(): void {
    if (db) {
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
