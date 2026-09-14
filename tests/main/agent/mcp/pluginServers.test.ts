import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const registryGet = vi.fn()
vi.mock('@/main/plugin/registry', () => ({
    PluginRegistry: {
        getInstance: () => ({ get: registryGet }),
    },
}))

import { loadMcpServersFromPlugin } from '@/main/agent/mcp/pluginServers'

let tmp = ''
function writePlugin(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-plugin-'))
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(root, rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, content, 'utf8')
    }
    return root
}

beforeEach(() => { registryGet.mockReset() })
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = '' })

// 本文件锁住 loadMcpServersFromPlugin 的「当前真实行为」，作为 C5 简化的回归网。
// 扫描前置条件：文件名（basename，不区分大小写）必须含 "mcp" 且后缀 .json；
// 因此所有涉及扫描的用例文件名均含 mcp（如 mcp-servers.json / a-mcp.json）。
describe('loadMcpServersFromPlugin', () => {
    it('插件不存在时返回空数组', () => {
        registryGet.mockReturnValue(undefined)
        expect(loadMcpServersFromPlugin('nope')).toEqual([])
    })

    // fixture 使用受支持的形态 1（{ mcpServers: { ... } }），使「返回 []」只能由「文件被过滤掉」解释：
    // 若文件名过滤被移除，other.json 会被解析出 1 条服务器 → 断言变红。
    it('忽略文件名不含 mcp 的 json', () => {
        tmp = writePlugin({
            'config/other.json': JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        expect(loadMcpServersFromPlugin('demo')).toEqual([])
    })

    // 各用例只放一个目录/一个文件，使断言失败时能唯一定位到对应跳过逻辑。
    // 若 tests 跳过逻辑被移除，mcp-hidden.json 会被解析出 1 条服务器 → 断言变红。
    it('跳过 tests 目录', () => {
        tmp = writePlugin({
            'tests/mcp-hidden.json': JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        expect(loadMcpServersFromPlugin('demo')).toEqual([])
    })

    // 若 node_modules 跳过逻辑被移除，mcp-dep.json 会被解析出 1 条服务器 → 断言变红。
    it('跳过 node_modules 目录', () => {
        tmp = writePlugin({
            'node_modules/mcp-dep.json': JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        expect(loadMcpServersFromPlugin('demo')).toEqual([])
    })

    // 若隐藏目录跳过逻辑被移除，mcp-cfg.json 会被解析出 1 条服务器 → 断言变红。
    it('跳过隐藏目录', () => {
        tmp = writePlugin({
            '.hidden/mcp-cfg.json': JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        expect(loadMcpServersFromPlugin('demo')).toEqual([])
    })

    // 形态 1：{ mcpServers: { "<name>": {...} } }（对象）
    // 条目 id 派生自 key，再由 tagPluginServer 加前缀 → 最终 id = "plugin:<plugin>:<name>"。
    // transport 补全规则：config.transport || config.type || (config.url ? 'http' : 'stdio')。
    it('形态 1：mcpServers 对象、仅 command → transport 补全为 stdio', () => {
        tmp = writePlugin({
            'mcp-servers.json': JSON.stringify({
                mcpServers: { alpha: { command: 'node', args: ['a.js'] } },
            }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        const servers = loadMcpServersFromPlugin('demo')
        expect(servers).toHaveLength(1)
        expect(servers[0].id).toBe('plugin:demo:alpha')
        expect(servers[0].transport).toBe('stdio')
    })

    it('形态 1：mcpServers 对象、带 url → transport 补全为 http', () => {
        tmp = writePlugin({
            'mcp-servers.json': JSON.stringify({
                mcpServers: { beta: { url: 'https://example.com/mcp' } },
            }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        const servers = loadMcpServersFromPlugin('demo')
        expect(servers).toHaveLength(1)
        expect(servers[0].id).toBe('plugin:demo:beta')
        expect(servers[0].transport).toBe('http')
    })

    // 形态 2：根为数组 [{...}]，至少一项含 command|args|transport|url → 原样返回该数组。
    // 数组条目没有 id 字段 → tagPluginServer 的 originalId 为 undefined → id = "plugin:demo:undefined"。
    it('形态 2：根为数组、含 command 字段 → 原样返回', () => {
        tmp = writePlugin({
            'a-mcp.json': JSON.stringify([{ command: 'node', args: ['x.js'] }]),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        const servers = loadMcpServersFromPlugin('demo')
        expect(servers).toHaveLength(1)
        expect(servers[0].id).toBe('plugin:demo:undefined')
        expect(servers[0].command).toBe('node')
    })

    // 形态 3：{ servers: [ {...} ] }（数组），至少一项含 command|args|transport|url → 返回 parsed.servers。
    it('形态 3：servers 为数组、含 command 字段 → 返回该数组', () => {
        tmp = writePlugin({
            'mcp-servers.json': JSON.stringify({ servers: [{ command: 'node' }] }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        const servers = loadMcpServersFromPlugin('demo')
        expect(servers).toHaveLength(1)
        expect(servers[0].id).toBe('plugin:demo:undefined')
        expect(servers[0].command).toBe('node')
    })

    // 负向用例：{ servers: { "<name>": {...} } }（servers 为对象，而非数组）不被支持 → []。
    // 文件名含 mcp，确保确实进入 parseMcpConfigFile，从而锁定「对象形态返回 []」这一当前行为。
    it('负向：servers 为对象（非数组）不被支持 → 返回空数组', () => {
        tmp = writePlugin({
            'mcp-object.json': JSON.stringify({
                servers: { alpha: { command: 'node', args: ['a.js'] } },
            }),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        expect(loadMcpServersFromPlugin('demo')).toEqual([])
    })

    // 注意：以下锁定的是「当前实现行为」，并非期望契约。
    // 形态 2/3 的数组条目没有 id，经 tagPluginServer 后 id 统一塌缩为 "plugin:demo:undefined"；
    // loadMcpServersFromSinglePlugin 的 seen 去重会把它们合并 → 两个文件的两条服务器最终只保留 1 条。
    it('当前行为：同插件内两个数组形态条目因 id 均塌缩为 plugin:demo:undefined 而合并为 1 条', () => {
        tmp = writePlugin({
            'a-mcp.json': JSON.stringify([{ command: 'node', args: ['a.js'] }]),
            'b-mcp.json': JSON.stringify([{ command: 'deno', args: ['b.js'] }]),
        })
        registryGet.mockReturnValue({ name: 'demo', path: tmp })
        const servers = loadMcpServersFromPlugin('demo')
        expect(servers).toHaveLength(1)
        expect(servers[0].id).toBe('plugin:demo:undefined')
    })
})
