import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from '@photostructure/sqlite'

let dir: string
vi.mock('../../../../../src/main/repositories/sqlite/index', () => ({
    getDatabaseFilePath: () => join(dir, 'hclaw.db'),
}))
vi.mock('../../../../../src/main/repositories/sqlite/toolRepository', () => ({
    toolRepo: {isEnabled: () => false},
}))

import {hclawDbQueryTool} from '../../../../../src/main/agent/tools/builtin/hclawDbQueryTool'
import {closeConnection} from '../../../../../src/main/agent/tools/builtin/hclawDbQueryConnection'

const noopCtx = () => ({
    workingDir: '', abortSignal: new AbortController().signal, sendMessage: () => {},
})

function makeDb(rows: number): void {
    dir = mkdtempSync(join(tmpdir(), 'hclaw-dbq-tool-'))
    const db = new DatabaseSync(join(dir, 'hclaw.db'))
    db.exec('CREATE TABLE t (id INTEGER, payload TEXT)')
    const stmt = db.prepare('INSERT INTO t VALUES (?, ?)')
    for (let i = 1; i <= rows; i++) stmt.run(i, 'row-' + i)
    db.close()
}

function parse(output: string): any { return JSON.parse(output) }

describe('hclawDbQueryTool', () => {
    beforeEach(() => { closeConnection(); makeDb(250) })
    afterEach(async () => {
        closeConnection()
        // Windows 上句柄释放可能延迟，短暂重试清理
        for (let i = 0; i < 10; i++) {
            try { rmSync(dir, {recursive: true, force: true}); return } catch { await new Promise((r) => setTimeout(r, 50)) }
        }
    })

    it('正常查询返回 JSON 行数组', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT id FROM t WHERE id <= 3'}, noopCtx() as any)
        expect(r.success).toBe(true)
        expect(parse(r.output).rows).toEqual([{id: 1}, {id: 2}, {id: 3}])
    })

    it.each([
        'INSERT INTO t VALUES (1, 1)', 'UPDATE t SET id = 1', 'DELETE FROM t',
        'PRAGMA journal_mode', "ATTACH 'x' AS y", 'SELECT 1; SELECT 2', '', 'bogus',
    ])('写/非法语句拒绝: %s', async sql => {
        const r = await hclawDbQueryTool.execute({sql}, noopCtx() as any)
        expect(r.success).toBe(false)
        expect(r.error).toBeTruthy()
    })

    it('无 LIMIT 时自动附加 LIMIT 101 并提示行数截断', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT * FROM t'}, noopCtx() as any)
        const out = parse(r.output)
        expect(out.rows).toHaveLength(100)
        expect(out.truncated).toBe(true)
        expect(out.notice).toContain('100')
    })

    it('已有 LIMIT 时不改写', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT * FROM t LIMIT 5'}, noopCtx() as any)
        expect(parse(r.output).rows).toHaveLength(5)
        expect(parse(r.output).truncated).toBe(false)
    })

    it('超长单元格截断', async () => {
        const db = new DatabaseSync(join(dir, 'hclaw.db'))
        db.prepare('INSERT INTO t VALUES (?, ?)').run(999, 'x'.repeat(5000))
        db.close()
        const r = await hclawDbQueryTool.execute({sql: 'SELECT payload FROM t WHERE id = 999'}, noopCtx() as any)
        const cell = parse(r.output).rows[0].payload as string
        expect(cell.length).toBeLessThan(4100)
        expect(cell).toContain('截断')
    })

    it('总输出 64KB 兜底：已有大 LIMIT 时也按字节截断', async () => {
        const db = new DatabaseSync(join(dir, 'hclaw.db'))
        db.exec('ALTER TABLE t ADD COLUMN big TEXT')
        const stmt = db.prepare('UPDATE t SET big = ? WHERE id = ?')
        for (let i = 1; i <= 250; i++) stmt.run('y'.repeat(2000), i)
        db.close()
        const r = await hclawDbQueryTool.execute({sql: 'SELECT big FROM t LIMIT 100000'}, noopCtx() as any)
        const out = parse(r.output)
        expect(out.truncated).toBe(true)
        expect(out.notice).toContain('字节')
        expect(out.rows.length).toBeLessThan(100)
    })

    it('尾随注释不吞掉附加的 LIMIT（行数上限仍生效）', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT * FROM t -- 取全部'}, noopCtx() as any)
        const out = parse(r.output)
        expect(out.rows).toHaveLength(100)
        expect(out.truncated).toBe(true)
    })

    it('块注释结尾同样不吞 LIMIT', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT * FROM t /* 取全部 */'}, noopCtx() as any)
        expect(parse(r.output).rows).toHaveLength(100)
    })

    it('注释内分号不放行为多语句拒绝', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT 1 AS one -- c;'}, noopCtx() as any)
        expect(r.success).toBe(true)
        expect(parse(r.output).rows).toEqual([{one: 1}])
    })

    it('已有 LIMIT 恰好 100 行不截断', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT * FROM t LIMIT 100'}, noopCtx() as any)
        const out = parse(r.output)
        expect(out.rows).toHaveLength(100)
        expect(out.truncated).toBe(false)
    })

    it('表不存在返回可读错误', async () => {
        const r = await hclawDbQueryTool.execute({sql: 'SELECT * FROM nope'}, noopCtx() as any)
        expect(r.success).toBe(false)
        expect(r.error).toContain('nope')
    })
})
