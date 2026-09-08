/**
 * hclaw_db_query — HClaw 自身数据库只读查询工具
 *
 * 仅查询 HClaw 系统数据库（data/hclaw.db），只读；其他数据库请使用用户配置的 MCP 工具。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {validateReadOnlySql, hasExistingLimit} from './hclawDbQuerySqlGuard'
import {queryReadOnly} from './hclawDbQueryConnection'
import {logger} from '../../logger'

const ROW_LIMIT = 100
const CELL_LIMIT = 4000
const OUTPUT_LIMIT = 64 * 1024 - 1024 // 64KB，留 1KB 余量给外层 JSON 包裹开销

const inputSchema = z.object({
    sql: z.string().min(1, 'SQL 不能为空'),
})

/** 单元格截断：超长值截断并标记 */
function truncateCell(v: unknown): unknown {
    if (typeof v === 'string' && v.length > CELL_LIMIT) {
        return v.slice(0, CELL_LIMIT) + `…[截断，原长 ${v.length} 字符]`
    }
    return v
}

/** 截断超长字符串单元格后返回新行对象 */
function fixedRow(row: Record<string, unknown>): Record<string, unknown> {
    const fixed: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) fixed[k] = truncateCell(v)
    return fixed
}

async function executeQuery(sqlRaw: string): Promise<ToolResult<string>> {
    // ① fail-closed 只读校验
    const check = validateReadOnlySql(sqlRaw)
    if (!check.ok) return {success: false, output: '', error: check.error}

    // ② LIMIT 策略：已含 LIMIT 不改写；未含则附加 LIMIT 101（多查 1 行判截断）
    // 换行前缀：避免尾随注释（-- 或 /* */）吞掉附加的 LIMIT 子句
    const sql = hasExistingLimit(sqlRaw) ? sqlRaw : `${sqlRaw}\nLIMIT ${ROW_LIMIT + 1}`

    // ③ 执行（连接管理器负责自愈）
    let rawRows: Record<string, unknown>[]
    try {
        rawRows = await queryReadOnly(sql)
    } catch (err) {
        return {success: false, output: '', error: `查询执行失败: ${String(err)}`}
    }

    // ④ 行数截断判定
    const rowTruncated = rawRows.length > ROW_LIMIT
    const rows = rowTruncated ? rawRows.slice(0, ROW_LIMIT) : rawRows

    // ⑤ 逐行截断单元格并序列化，64KB 字节兜底
    const outRows: Record<string, unknown>[] = []
    let size = 0
    let byteTruncated = false
    for (const row of rows) {
        const fixed = fixedRow(row)
        const lineBytes = Buffer.byteLength(JSON.stringify(fixed), 'utf8')
        if (size + lineBytes > OUTPUT_LIMIT) { byteTruncated = true; break }
        outRows.push(fixed)
        size += lineBytes
    }

    const notices: string[] = []
    if (rowTruncated) notices.push(`结果超过 ${ROW_LIMIT} 行已截断，请加 WHERE/LIMIT 收窄查询`)
    if (byteTruncated) notices.push(`输出超过 64KB 已按字节截断（已返回 ${outRows.length} 行），请减少列或收窄查询`)

    return {
        success: true,
        output: JSON.stringify({
            rows: outRows,
            truncated: rowTruncated || byteTruncated,
            ...(notices.length ? {notice: notices.join('；')} : {}),
        }),
    }
}

export const hclawDbQueryTool: Tool<{sql: string}, string> = {
    name: 'hclaw_db_query',
    description:
        '查询 HClaw 系统自身数据库（data/hclaw.db，只读）。仅支持单条 SELECT/WITH 聚合查询，' +
        '不支持 INSERT/UPDATE/DELETE 等写操作。可用于检索历史会话、任务、使用统计等系统数据。\n' +
        '【重要】此工具只针对 HClaw 自身数据库；查询其他数据库请使用用户配置的 MCP 数据库工具。\n' +
        "表结构探查: SELECT name, sql FROM sqlite_master WHERE type='table'。" +
        '典型表: conversations（会话）、messages（消息）、message_blocks（消息内容块）、tasks（任务）、llm_usage（模型用量）。',
    inputSchema,
    isDestructive: false,

    async execute(args: {sql: string}, _context: ToolContext): Promise<ToolResult<string>> {
        try {
            return await executeQuery(args.sql)
        } catch (err) {
            logger.error('[hclaw_db_query] unexpected error', {error: err})
            return {success: false, output: '', error: `工具执行异常: ${String(err)}`}
        }
    },
}
