// @vitest-environment jsdom
/**
 * BUG：ultra-compact 模式下 PopupToolCard 展开后看不到 hclaw_db_query 的 SQL。
 *
 * 根因：getToolDetail / getToolSummary / getToolArgSummary 三函数对 hclaw_db_query
 * 无显式分支也无通用兜底 → 返回 null → 弹窗参数区不渲染、摘要芯片空白。
 * 同类受影响工具：task_create / channel_send / scheduler_manage 等未列名内置工具。
 */
import {describe, it, expect} from 'vitest'
import {
    getToolSummary,
    getToolArgSummary,
    getToolDetail,
    formatToolArgs,
} from '../../../../src/renderer/components/message-list/utils/messageUtils'

const SQL = 'SELECT id, name FROM providers LIMIT 50'

const TC_HCLAW_DB_QUERY = {
    id: 'tc-dbq-1',
    name: 'hclaw_db_query',
    arguments: {sql: SQL, reason: '排查 bug'},
    status: 'success' as const,
}

const TC_UNKNOWN_TOOL = {
    id: 'tc-unk-1',
    name: 'some_future_tool',
    arguments: {foo: 'bar', count: 3, reason: 'just because'},
    status: 'success' as const,
}

describe('messageUtils — hclaw_db_query SQL 可见性', () => {
    it('getToolDetail 返回 SQL 字符串（非 null）', () => {
        const detail = getToolDetail(TC_HCLAW_DB_QUERY as any)
        expect(detail).not.toBeNull()
        expect(detail).toContain(SQL)
    })

    it('getToolSummary 返回截断的 SQL 摘要', () => {
        expect(getToolSummary(TC_HCLAW_DB_QUERY as any)).not.toBeNull()
        expect(getToolSummary(TC_HCLAW_DB_QUERY as any)).toContain('SELECT')
    })

    it('getToolArgSummary 返回截断的 SQL 摘要', () => {
        expect(getToolArgSummary(TC_HCLAW_DB_QUERY as any)).not.toBeNull()
        expect(getToolArgSummary(TC_HCLAW_DB_QUERY as any)).toContain('SELECT')
    })
})

describe('messageUtils — 未列名工具通用兜底（举一反三）', () => {
    it('getToolDetail 对未知工具返回参数 JSON（非 null）', () => {
        const detail = getToolDetail(TC_UNKNOWN_TOOL as any)
        expect(detail).not.toBeNull()
        // 不包含 reason 字段
        expect(detail).not.toContain('just because')
        expect(detail).toContain('foo')
        expect(detail).toContain('bar')
    })
})

describe('formatToolArgs 不受影响（回归）', () => {
    it('过滤 reason 字段后 JSON 序列化', () => {
        const out = formatToolArgs({sql: SQL, reason: '排查 bug'} as any)
        expect(out).toContain(SQL)
        expect(out).not.toContain('排查 bug')
    })
})
