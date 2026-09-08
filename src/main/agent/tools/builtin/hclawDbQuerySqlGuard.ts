/**
 * hclaw_db_query SQL 只读校验（fail-closed）
 *
 * 三层防护：
 * 1. 顶层语句分隔符检测（node-sql-parser 对多语句可能静默只解析第一条，不能依赖）
 * 2. node-sql-parser 解析，仅放行 SELECT（含 WITH CTE）
 * 3. 解析失败一律拒绝
 */
import {Parser} from 'node-sql-parser'

const parser = new Parser()

/** 去除尾部空白与单个分号（单个尾分号是合法习惯；只裁一个，避免吞掉内部多语句分号） */
function trimTrailing(sql: string): string {
    return sql.replace(/\s*;\s*$/u, '')
}

/**
 * 窄面预处理：sqlite_master 查询中裸 `sql` 列名（如 SELECT name, sql FROM sqlite_master）
 * 被 node-sql-parser 各方言视为保留字导致解析失败；加引号后重试一次，仍失败则拒绝。
 * 仅替换字符串字面量之外的裸 `sql`，确保重试文本不会篡改字面量内容。
 */
function quoteBareSqlColumn(sql: string): string {
    // 按字符串字面量边界切分原文，仅对字面量之外的非字面量片段应用替换
    let out = ''
    let lit: string | null = null
    let buf = ''
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i]
        if (lit) {
            buf += ch
            if (ch === lit) { out += buf; buf = ''; lit = null }
            continue
        }
        if (ch === "'" || ch === '"') {
            out += rewriteBareSql(buf)
            buf = ch
            lit = ch
            continue
        }
        buf += ch
    }
    out += rewriteBareSql(buf)
    return out
}

function rewriteBareSql(segment: string): string {
    return segment.replace(/\bsql\b(?=\s*(?:[,)\]]|from\b|$))/gi, '"sql"')
}

/**
 * 剥离字符串字面量之外的注释（单行 `--` 与块 `/* ... *`/），替换为空白（保留换行）。
 * 字面量内的注释样文本不受影响；未闭合的块注释视为注释到末尾（后续解析会拒绝）。
 */
function maskComments(sql: string): string {
    let out = ''
    let state: 'code' | 'sq' | 'dq' | 'line' | 'block' = 'code'
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i]
        const next = sql[i + 1]
        if (state === 'code') {
            if (ch === "'") { state = 'sq'; out += ch }
            else if (ch === '"') { state = 'dq'; out += ch }
            else if (ch === '-' && next === '-') { state = 'line'; out += '  ' }
            else if (ch === '/' && next === '*') { state = 'block'; out += '  ' }
            else out += ch
        } else if (state === 'sq') {
            out += ch
            if (ch === "'") {
                if (next === "'") { out += next; i++ } // '' 转义
                else state = 'code'
            }
        } else if (state === 'dq') {
            out += ch
            if (ch === '"') state = 'code'
        } else if (state === 'line') {
            out += ch === '\n' ? '\n' : ' '
            if (ch === '\n') state = 'code'
        } else { // block
            out += ch === '\n' ? '\n' : ' '
            if (ch === '*' && next === '/') { out += '/'; i++; state = 'code' }
        }
    }
    return out
}

/** 去除字符串字面量内容（保留引号定界符用于状态切换），供顶层分号/LIMIT 检测使用 */
function stripStringLiterals(sql: string): string {
    let inString: string | null = null
    let out = ''
    for (const ch of sql) {
        if (inString) {
            if (ch === inString) inString = null
            continue
        }
        if (ch === "'" || ch === '"') { inString = ch; continue }
        out += ch
    }
    return out
}

/** 检测字符串字面量与注释之外的顶层分号（多语句迹象） */
export function hasTopLevelSemicolon(sqlRaw: string): boolean {
    return stripStringLiterals(maskComments(trimTrailing(sqlRaw))).includes(';')
}

/** SQL 是否已含顶层 LIMIT 子句（字面量内、注释内的不算） */
export function hasExistingLimit(sqlRaw: string): boolean {
    return /\bLIMIT\s+\d+/i.test(stripStringLiterals(maskComments(trimTrailing(sqlRaw))))
}

export function validateReadOnlySql(sqlRaw: string): { ok: true } | { ok: false; error: string } {
    const sql = sqlRaw.trim()
    if (!sql) return {ok: false, error: 'SQL 不能为空'}
    // 注意：用未裁分号的原文检测（trimTrailing 只裁一个尾分号，'SELECT 1; ;' 须在此被拦截）
    if (hasTopLevelSemicolon(sql)) {
        return {ok: false, error: '不支持多语句查询：请一次只执行一条 SELECT 语句'}
    }
    try {
        // node-sql-parser 返回 {tableList, columnList, ast} 包装；多语句时 ast 为数组
        // 方言用 sqlite，与运行时引擎一致
        const parseOnce = (s: string) => {
            const parsed = parser.parse(s, {database: 'sqlite'})
            return Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast]
        }
        let stmts: unknown[]
        try {
            stmts = parseOnce(sql)
        } catch {
            stmts = parseOnce(quoteBareSqlColumn(sql))
        }
        if (stmts.length !== 1) {
            return {ok: false, error: '不支持多语句查询：请一次只执行一条 SELECT 语句'}
        }
        const type = (stmts[0] as {type?: string}).type
        if (type !== 'select') {
            return {ok: false, error: `仅支持 SELECT 查询，收到: ${type ?? 'unknown'}`}
        }
        return {ok: true}
    } catch (err) {
        return {ok: false, error: `SQL 解析失败（仅支持单条 SELECT）: ${String(err)}`}
    }
}
