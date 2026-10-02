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

import {getLastSentToolsRecord, recordLastSentToolNames, isSameToolNameSequence, evaluateToolsChange} from '../../../../src/main/agent/loop/toolsSentRecord'
import {filterTools, applyMcpCatalogChannel} from '../../../../src/main/agent/loop/setup'
import * as modelCapability from '../../../../src/main/agent/modelCapability'
import type {ToolDefinitionForLLM} from '../../../../src/main/agent/tools/types'

beforeEach(() => {
    store.data = {}
})

describe('toolsSentRecord 持久化读写', () => {
    it('写入后可读回（跨 Worker 生命周期：数据在 system_settings 而非模块内存）', () => {
        recordLastSentToolNames('conv-a', ['read_file', 'write_file'], 'model-1')
        expect(getLastSentToolsRecord('conv-a')).toEqual({model: 'model-1', names: ['read_file', 'write_file']})
    })

    it('按 conversationId 隔离', () => {
        recordLastSentToolNames('conv-a', ['read_file'], 'model-1')
        recordLastSentToolNames('conv-b', ['glob'], 'model-2')
        expect(getLastSentToolsRecord('conv-a')).toEqual({model: 'model-1', names: ['read_file']})
        expect(getLastSentToolsRecord('conv-b')).toEqual({model: 'model-2', names: ['glob']})
    })

    it('重复写入覆盖为最新一轮（model 与 names 同步更新）', () => {
        recordLastSentToolNames('conv-a', ['read_file'], 'model-1')
        recordLastSentToolNames('conv-a', ['read_file', 'write_file'], 'model-2')
        expect(getLastSentToolsRecord('conv-a')).toEqual({model: 'model-2', names: ['read_file', 'write_file']})
    })

    it('无记录 / 结构损坏 / 缺字段 → undefined', () => {
        expect(getLastSentToolsRecord('nope')).toBeUndefined()
        store.data['tools_sent_last:bad'] = '{"not":"an array"}'
        expect(getLastSentToolsRecord('bad')).toBeUndefined()
        store.data['tools_sent_last:bad2'] = 'not-json'
        expect(getLastSentToolsRecord('bad2')).toBeUndefined()
        // 缺 model
        store.data['tools_sent_last:noModel'] = JSON.stringify({names: ['read_file']})
        expect(getLastSentToolsRecord('noModel')).toBeUndefined()
        // model 类型不对
        store.data['tools_sent_last:badModel'] = JSON.stringify({model: 1, names: ['read_file']})
        expect(getLastSentToolsRecord('badModel')).toBeUndefined()
        // names 非 string[]
        store.data['tools_sent_last:badNames'] = JSON.stringify({model: 'model-1', names: 'read_file'})
        expect(getLastSentToolsRecord('badNames')).toBeUndefined()
        store.data['tools_sent_last:badNames2'] = JSON.stringify({model: 'model-1', names: [1, 2]})
        expect(getLastSentToolsRecord('badNames2')).toBeUndefined()
    })

    it('旧格式（裸数组，无 model 字段）→ undefined（视为无记录）', () => {
        store.data['tools_sent_last:legacy'] = JSON.stringify(['read_file', 'write_file'])
        expect(getLastSentToolsRecord('legacy')).toBeUndefined()
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

// ─── tools 变动门判据：跨模型仅图片工具互换 → 放行（prompt cache 本就不共享） ───
describe('evaluateToolsChange（tools 变动门判据）', () => {
    const rec = (model: string, names: string[]) => ({model, names})

    it('无记录（首轮）→ confirm=false', () => {
        expect(evaluateToolsChange(undefined, ['read_file'], 'model-1')).toEqual({confirm: false, added: [], removed: []})
    })

    it('模型相同 + 图片工具互换（analyze→load）→ confirm=true（400 降级/自愈提醒保留）', () => {
        const r = evaluateToolsChange(rec('model-1', ['read_file', 'analyze_image']), ['read_file', 'load_image'], 'model-1')
        expect(r.confirm).toBe(true)
        expect(r.added).toEqual(['load_image'])
        expect(r.removed).toEqual(['analyze_image'])
    })

    it('模型不同 + 仅图片工具差异 → confirm=false，added/removed 正确', () => {
        const r = evaluateToolsChange(rec('model-1', ['read_file', 'analyze_image']), ['read_file', 'load_image'], 'model-2')
        expect(r.confirm).toBe(false)
        expect(r.added).toEqual(['load_image'])
        expect(r.removed).toEqual(['analyze_image'])
    })

    it('模型不同 + 含非图片工具差异 → confirm=true', () => {
        const r = evaluateToolsChange(
            rec('model-1', ['read_file', 'analyze_image']),
            ['read_file', 'load_image', 'write_file'],
            'model-2',
        )
        expect(r.confirm).toBe(true)
        expect(r.added).toEqual(['load_image', 'write_file'])
        expect(r.removed).toEqual(['analyze_image'])
    })

    it('模型相同 + 顺序变化（集合相同）→ confirm=true（顺序敏感语义保持）', () => {
        const r = evaluateToolsChange(rec('model-1', ['read_file', 'write_file']), ['write_file', 'read_file'], 'model-1')
        expect(r.confirm).toBe(true)
        expect(r.added).toEqual([])
        expect(r.removed).toEqual([])
    })

    it('模型不同 + 集合完全相同（仅顺序变化）→ confirm=false', () => {
        const r = evaluateToolsChange(rec('model-1', ['read_file', 'write_file']), ['write_file', 'read_file'], 'model-2')
        expect(r.confirm).toBe(false)
        expect(r.added).toEqual([])
        expect(r.removed).toEqual([])
    })

    it('模型不同 + 集合与顺序均相同 → confirm=false', () => {
        expect(evaluateToolsChange(rec('model-1', ['read_file']), ['read_file'], 'model-2').confirm).toBe(false)
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
