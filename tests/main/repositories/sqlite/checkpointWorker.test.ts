// @vitest-environment node
import {describe, expect, it, beforeAll, afterAll} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {DatabaseSync, enhance} from '@photostructure/sqlite'
import {createCheckpointController} from '../../../../src/main/repositories/sqlite/checkpointWorker'

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
