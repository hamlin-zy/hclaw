import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from '@photostructure/sqlite'

// 每个用例独立临时库；vi.mock getDatabaseFilePath 指向它
let dbFile: string
let dir: string

vi.mock('../../../../../src/main/repositories/sqlite/index', () => ({
    getDatabaseFilePath: () => dbFile,
}))
vi.mock('../../../../../src/main/repositories/sqlite/toolRepository', () => ({
    toolRepo: {isEnabled: vi.fn(() => true)},
}))

import {
    ensureConnection, closeConnection, isReady,
    initHclawDbQueryConnection, queryReadOnly,
} from '../../../../../src/main/agent/tools/builtin/hclawDbQueryConnection'

function createFixtureDb(): string {
    dir = mkdtempSync(join(tmpdir(), 'hclaw-dbq-'))
    dbFile = join(dir, 'hclaw.db')
    const db = new DatabaseSync(dbFile)
    db.exec('CREATE TABLE t (id INTEGER, name TEXT)')
    db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')")
    db.close()
    return dbFile
}

describe('hclawDbQueryConnection', () => {
    beforeEach(() => { createFixtureDb(); closeConnection() })
    afterEach(async () => {
        closeConnection()
        // Windows 上句柄释放可能延迟，短暂重试清理
        for (let i = 0; i < 10; i++) {
            try { rmSync(dir, {recursive: true, force: true}); return } catch { await new Promise((r) => setTimeout(r, 50)) }
        }
    })

    it('ensureConnection 返回可用连接且多次调用为同一实例', async () => {
        const c1 = await ensureConnection()
        expect(isReady()).toBe(true)
        expect(await ensureConnection()).toBe(c1)
    })

    it('closeConnection 后 isReady 为 false，且重复 close 幂等', async () => {
        await ensureConnection()
        closeConnection()
        expect(isReady()).toBe(false)
        expect(() => closeConnection()).not.toThrow()
    })

    it('queryReadOnly 执行 SELECT 返回行对象数组', async () => {
        expect(await queryReadOnly('SELECT * FROM t ORDER BY id')).toEqual([
            {id: 1, name: 'a'}, {id: 2, name: 'b'},
        ])
    })

    it('连接失效后 queryReadOnly 自愈：重建并重试成功', async () => {
        const stale = await ensureConnection()
        // 调整（Windows EPERM 限制，见任务报告）：只读句柄持有期间无法 rmSync db 文件，
        // 改用「外部关闭旧句柄模拟失效 + 第二个可写连接写入新数据」验证自愈
        const writer = new DatabaseSync(dbFile)
        writer.exec("INSERT INTO t VALUES (9, 'fresh')")
        writer.close()
        stale.close() // 模拟旧句柄失效（库文件被删除/替换场景的等价模拟）
        // 自愈：健康检查失败 → 锁内重建 → 重试命中新数据
        expect(await queryReadOnly('SELECT * FROM t ORDER BY id')).toEqual([
            {id: 1, name: 'a'}, {id: 2, name: 'b'}, {id: 9, name: 'fresh'},
        ])
        expect(isReady()).toBe(true)
        expect(await ensureConnection()).not.toBe(stale)
    })

    it('并发 N 次 ensureConnection（连接缺失时）只创建一个连接', async () => {
        const results = await Promise.all(
            Array.from({length: 10}, () => ensureConnection()),
        )
        expect(new Set(results).size).toBe(1)
    })

    it('initHclawDbQueryConnection 在 enabled 时预热建连', async () => {
        initHclawDbQueryConnection()
        // 预热为异步锁内建连，等待就绪
        for (let i = 0; i < 50 && !isReady(); i++) {
            await new Promise((r) => setTimeout(r, 10))
        }
        expect(isReady()).toBe(true)
    })

    it('initHclawDbQueryConnection 建连失败不产生 unhandled rejection 且不崩溃', async () => {
        // 指向不存在的目录，使预热建连必然失败
        dbFile = join(dir, 'nonexistent-subdir', 'broken.db')
        try {
            expect(() => initHclawDbQueryConnection()).not.toThrow()
            // 留出微任务/宏任务时间：若存在 unhandled rejection 此处会使进程/vitest 报错
            for (let i = 0; i < 20; i++) {
                await new Promise((r) => setTimeout(r, 10))
            }
            expect(isReady()).toBe(false)
        } finally {
            dbFile = join(dir, 'hclaw.db')
        }
    })

    it('queryReadOnly 对写语句抛错（引擎层兜底）', async () => {
        await expect(queryReadOnly('DELETE FROM t')).rejects.toThrow()
    })

    it('queryReadOnly SQL 错误时连接健康则直接抛原始错误，不重建连接', async () => {
        const c = await ensureConnection()
        await expect(queryReadOnly('SELECT * FROM no_such_table')).rejects.toThrow()
        // 连接健康 → 不走 close/重建路径，句柄保持原样
        expect(isReady()).toBe(true)
        expect(await ensureConnection()).toBe(c)
        // 同一连接仍可正常查询
        expect(await queryReadOnly('SELECT COUNT(*) AS n FROM t')).toEqual([{n: 2}])
    })
})
