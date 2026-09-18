// @vitest-environment node
import {describe, expect, it, beforeAll, afterAll, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {DatabaseSync, enhance} from '@photostructure/sqlite'
import {createCheckpointController} from '../../../../src/main/repositories/sqlite/checkpointWorker'

// ── S7 关闭期竞态：Worker 构造计数（唯一观察点）───────────────────────
// 真 Worker 需要 checkpointWorker.js 构建产物，单测环境不可用；此处只记录「拉起次数」。
// 其余导出经 importOriginal 原样透传（checkpointWorker.ts 也用本模块的 parentPort/workerData）。
const workerSpawns = vi.hoisted(() => ({scripts: [] as string[]}))
vi.mock('node:worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:worker_threads')>()
    class CountingWorker {
        constructor(script: string) {
            workerSpawns.scripts.push(String(script))
        }

        on() {
            return this
        }

        terminate() {
            return Promise.resolve(0)
        }
    }

    return {...actual, Worker: CountingWorker as unknown as typeof actual.Worker}
})

let dir: string
let dbPath: string

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-test-'))
    dbPath = path.join(dir, 'test.db')
})

afterAll(() => {
    // 尽力清理：Windows 下 enhance 的 db.pragma() 会泄漏原生 statement 句柄，
    // 使 test.db/-wal/-shm 保持锁定，rmSync 抛 EPERM。套 try/catch 保证 suite 通过
    // （临时目录残留在 os.tmpdir() 下，不触碰真实数据；与 recovery 测试约定一致）。
    try {
        fs.rmSync(dir, {recursive: true, force: true})
    } catch {
        // ignore Windows file-lock cleanup errors
    }
})

describe('checkpoint worker 核心逻辑', () => {
    it('WAL 超过阈值时 checkpoint 截断 WAL 文件', () => {
        const db = enhance(new DatabaseSync(dbPath))
        db.pragma('journal_mode = WAL')
        // 关闭 autocheckpoint：默认 1000 页(≈4MB)自动 checkpoint 会兜住 WAL 体积，
        // 无论写多少数据 WAL 都停留在 ~4MB，无法越过 64MB 阈值触发 TRUNCATE。
        db.pragma('wal_autocheckpoint = 0')
        // 写入数据撑大 WAL（多行大文本，6000 行 × 4KB ≈ 75MB WAL，超过 64MB 阈值）
        db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, payload TEXT)')
        const ins = db.prepare('INSERT INTO t (payload) VALUES (?)')
        const big = 'x'.repeat(4000)
        for (let i = 0; i < 6000; i++) ins.run(big)
        const walBefore = fs.statSync(dbPath + '-wal').size
        expect(walBefore).toBeGreaterThan(0)

        const ctrl = createCheckpointController(dbPath)
        ctrl.check()

        const walAfter = fs.statSync(dbPath + '-wal').size
        expect(walAfter).toBeLessThan(walBefore)  // TRUNCATE 后 WAL 缩小
        db.close()
    })
})

describe('S7 关闭期不再启动 checkpoint worker', () => {
    // 隔离：getHclawDir 重定向到 tmpdir，绝不触碰真实 ~/.hclaw/data/hclaw.db
    // （mock 形态与 tests/main/persistence.integration.test.ts 一致）。
    let closeDir: string

    beforeAll(() => {
        closeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-closing-'))
        vi.doMock('../../../../src/main/hclawPaths', () => ({
            getHclawDir: () => closeDir,
            HCLAW_DIR: closeDir,
            getHclawDataDir: () => path.join(closeDir, 'data'),
            isSafePath: (p: string) => p.startsWith(closeDir),
        }))
    })

    afterAll(() => {
        try {
            fs.rmSync(closeDir, {recursive: true, force: true})
        } catch {
            // ignore Windows file-lock cleanup errors
        }
    })

    it('flushDatabase 后 saveDatabase 不重启 worker（关闭期走同步兜底）', async () => {
        const sqlite = await import('../../../../src/main/repositories/sqlite/index')
        sqlite.initDatabaseSync()
        const spawned = workerSpawns.scripts.length
        expect(spawned).toBeGreaterThan(0)   // 控制组：正常启动确实拉起 worker

        sqlite.flushDatabase()   // 退出路径：置关闭标志 + 停 worker
        sqlite.saveDatabase()    // 竞态点：in-flight 落库在 flush 之后触发

        expect(workerSpawns.scripts.length).toBe(spawned)
        sqlite.closeDatabase()   // 释放文件句柄，便于 tmpdir 清理
    })

    it('closeDatabase 后（关闭期仍有落库路径）不重启 worker', async () => {
        vi.resetModules()   // 取一份全新的模块状态（关闭标志复位）
        const sqlite = await import('../../../../src/main/repositories/sqlite/index')
        sqlite.initDatabaseSync()
        const spawned = workerSpawns.scripts.length

        sqlite.closeDatabase()   // 置关闭标志 + 关库
        sqlite.getDatabase()     // 关闭期仍有调用方重新打开连接
        sqlite.saveDatabase()

        expect(workerSpawns.scripts.length).toBe(spawned)
        sqlite.closeDatabase()
    })
})
