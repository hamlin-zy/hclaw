/**
 * tools 发送记录（system_settings 持久化）单测。
 *
 * 覆盖缺陷 1（跨 run 持久化）与缺陷 5（顺序敏感比较）：
 * 记录必须落 DB 且按 conversationId 隔离，新 Worker 读得到；
 * 比较必须顺序敏感（tools 编码顺序变化同样断缓存）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

const store = vi.hoisted(() => ({data: {} as Record<string, string>}))

vi.mock('../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {
        get: (key: string) => store.data[key] ?? null,
        set: (key: string, value: string) => {
            store.data[key] = value
            return true
        },
        getJson: (key: string) => {
            const raw = store.data[key]
            return raw ? JSON.parse(raw) : null
        },
        setJson: (key: string, value: unknown) => {
            store.data[key] = JSON.stringify(value)
            return true
        },
        delete: (key: string) => {
            delete store.data[key]
            return true
        },
        getAll: () => ({...store.data}),
    },
}))

import {getLastSentToolNames, recordLastSentToolNames, isSameToolNameSequence} from '../../../../src/main/agent/loop/toolsSentRecord'
import {filterTools, applyMcpCatalogChannel} from '../../../../src/main/agent/loop/setup'
import * as modelCapability from '../../../../src/main/agent/modelCapability'
import type {ToolDefinitionForLLM} from '../../../../src/main/agent/tools/types'

beforeEach(() => {
    store.data = {}
})

describe('toolsSentRecord 持久化读写', () => {
    it('写入后可读回（跨 Worker 生命周期：数据在 system_settings 而非模块内存）', () => {
        recordLastSentToolNames('conv-a', ['read_file', 'write_file'])
        expect(getLastSentToolNames('conv-a')).toEqual(['read_file', 'write_file'])
    })

    it('按 conversationId 隔离', () => {
        recordLastSentToolNames('conv-a', ['read_file'])
        recordLastSentToolNames('conv-b', ['glob'])
        expect(getLastSentToolNames('conv-a')).toEqual(['read_file'])
        expect(getLastSentToolNames('conv-b')).toEqual(['glob'])
    })

    it('重复写入覆盖为最新一轮', () => {
        recordLastSentToolNames('conv-a', ['read_file'])
        recordLastSentToolNames('conv-a', ['read_file', 'write_file'])
        expect(getLastSentToolNames('conv-a')).toEqual(['read_file', 'write_file'])
    })

    it('无记录 / 结构损坏 → undefined', () => {
        expect(getLastSentToolNames('nope')).toBeUndefined()
        store.data['tools_sent_last:bad'] = '{"not":"an array"}'
        expect(getLastSentToolNames('bad')).toBeUndefined()
        store.data['tools_sent_last:bad2'] = 'not-json'
        expect(getLastSentToolNames('bad2')).toBeUndefined()
    })
})

describe('isSameToolNameSequence（顺序敏感）', () => {
    it('相同顺序 → true', () => {
        expect(isSameToolNameSequence(['a', 'b'], ['a', 'b'])).toBe(true)
    })

    it('长度不同 → false', () => {
        expect(isSameToolNameSequence(['a'], ['a', 'b'])).toBe(false)
    })

    it('集合相同但顺序不同 → false（tools 编码顺序变化同样断缓存）', () => {
        expect(isSameToolNameSequence(['a', 'b'], ['b', 'a'])).toBe(false)
    })
})

// ─── P0-2：tools 生成端顺序稳定（数组序，与上面的"比较函数顺序敏感"互补）───
/**
 * 前缀缓存要求 tools 数组字节稳定。上面一组只验证「顺序变化能被发现」；
 * 本组验证「生成端不产生无谓的顺序变化」——即 filterTools → applyMcpCatalogChannel
 * 全链路保序（不排序、不重排），生成端被改坏时此前无人发现。
 */
function llmTool(name: string): ToolDefinitionForLLM {
    return {name, description: `desc-${name}`, inputSchema: {type: 'object', properties: {}}}
}

describe('tools 生成端全链路保序（P0-2）', () => {
    afterEach(() => vi.restoreAllMocks())

    it('filterTools → applyMcpCatalogChannel：非 MCP 项保序、MCP 剔除、call_mcp_tool 归位末尾', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(false)
        const base = [llmTool('m_srv_ocr'), llmTool('file_read'), llmTool('call_mcp_tool'), llmTool('glob')]

        // 第一段：能力过滤（显式传入 baseTools，避免依赖 toolRegistry/DB）
        const filtered = await filterTools(undefined, 'General', 'any-model', undefined, base)
        expect(filtered.map(t => t.name)).toEqual(['m_srv_ocr', 'file_read', 'call_mcp_tool', 'glob'])

        // 第二段：catalog 通道（MCP 工具移出 tools 数组，调用器归位末尾）
        const callMcp = llmTool('call_mcp_tool')
        const sent = applyMcpCatalogChannel(filtered, callMcp)
        expect(sent.map(t => t.name)).toEqual(['file_read', 'glob', 'call_mcp_tool'])
        // 判别力自检：与字典序不同 → 若生成端排序/重排，本断言立即红
        expect(sent.map(t => t.name)).not.toEqual(['call_mcp_tool', 'file_read', 'glob'])

        // 幂等 + 字节确定性：重复应用不改变最终形态（缓存前缀稳定）
        const again = applyMcpCatalogChannel(sent, callMcp)
        expect(again.map(t => t.name)).toEqual(['file_read', 'glob', 'call_mcp_tool'])
        expect(JSON.stringify(again)).toBe(JSON.stringify(sent))
    })

    it('applyMcpCatalogChannel：上游未保留调用器时不上抬 MCP 工具位置（原序保留）', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(false)
        const base = [llmTool('m_srv_ocr'), llmTool('file_read'), llmTool('glob')]
        const filtered = await filterTools(undefined, 'General', 'any-model', undefined, base)
        // 上游白名单未保留 call_mcp_tool → 仅剔除泄漏调用器，MCP 工具原样保留（含原位置）
        const sent = applyMcpCatalogChannel(filtered, llmTool('call_mcp_tool'))
        expect(sent.map(t => t.name)).toEqual(['m_srv_ocr', 'file_read', 'glob'])
    })
})
