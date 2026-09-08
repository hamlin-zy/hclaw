import {describe, it, expect} from 'vitest'
import {validateReadOnlySql, hasTopLevelSemicolon, hasExistingLimit} from '../../../../../src/main/agent/tools/builtin/hclawDbQuerySqlGuard'

describe('validateReadOnlySql', () => {
    const ok = ['SELECT * FROM t', 'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
        'SELECT COUNT(*) FROM t GROUP BY id', 'SELECT name, sql FROM sqlite_master',
        "SELECT * FROM t WHERE name = 'a;b'"] // 字符串字面量内分号不误杀
    it.each(ok)('放行: %s', s => expect(validateReadOnlySql(s).ok).toBe(true))

    const bad = ['INSERT INTO t VALUES (1)', 'UPDATE t SET name = 1', 'DELETE FROM t',
        'CREATE TABLE x (a)', 'DROP TABLE t', 'PRAGMA journal_mode', "ATTACH 'x' AS y",
        'SELECT 1; SELECT 2', 'SELECT 1; DROP TABLE t', '', '   ', 'not sql at all']
    it.each(bad)('拒绝: %s', s => expect(validateReadOnlySql(s).ok).toBe(false))

    it('拒绝末尾多余分号后的第二条语句，但放行单个尾分号', () => {
        expect(validateReadOnlySql('SELECT 1;').ok).toBe(true)
        expect(validateReadOnlySql('SELECT 1; ;').ok).toBe(false)
    })

    it('字面量内含 sql from 的语法错误 SQL 仍拒绝（字面量不被重试路径篡改后误放行）', () => {
        expect(validateReadOnlySql("SELECT name, 'please sql from me' FROM sqlite_master WHERE (").ok).toBe(false)
        expect(validateReadOnlySql("SELECT name, 'sql from' FROM t WHERE (").ok).toBe(false)
    })
})

describe('hasTopLevelSemicolon', () => {
    it('字符串字面量内的分号不算顶层', () => {
        expect(hasTopLevelSemicolon("SELECT 'a;b'")).toBe(false)
        expect(hasTopLevelSemicolon('SELECT 1;')).toBe(false) // 已 trim 尾分号
        expect(hasTopLevelSemicolon('SELECT 1; SELECT 2')).toBe(true)
        // 注释内的分号不算顶层（fail-closed 不削弱：真多语句仍拦截）
        expect(hasTopLevelSemicolon('SELECT 1 -- c;')).toBe(false)
        expect(hasTopLevelSemicolon('SELECT 1 /* ; */')).toBe(false)
        expect(hasTopLevelSemicolon("SELECT ';' ; SELECT 2")).toBe(true) // 顶层真分号仍拦截（字面量内的不算）
    })
})

describe('hasExistingLimit', () => {
    it('识别已有 LIMIT 子句', () => {
        expect(hasExistingLimit('SELECT * FROM t LIMIT 10')).toBe(true)
        expect(hasExistingLimit('SELECT * FROM t limit 5 offset 2')).toBe(true)
        expect(hasExistingLimit('SELECT * FROM t')).toBe(false)
        expect(hasExistingLimit("SELECT * FROM t WHERE c = 'LIMIT 3'")).toBe(false) // 字面量内不算
    })

    it('注释内的 LIMIT 不算已有 LIMIT（避免吞掉自动附加）', () => {
        expect(hasExistingLimit('SELECT 1 -- LIMIT 5')).toBe(false)
        expect(hasExistingLimit('SELECT 1 /* LIMIT 5 */')).toBe(false)
        expect(hasExistingLimit("SELECT 'LIMIT 9' /* x */ LIMIT 2")).toBe(true)
    })
})
