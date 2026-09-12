import {describe, it, expect} from 'vitest'
import {checkResultSize} from '../../src/main/agent/tools/executor'

describe('checkResultSize — MCP 工具豁免', () => {
    const bigOutput = 'x'.repeat(20_000)

    it('m_ 前缀 MCP 工具 20KB 结果不被截断', () => {
        const r = checkResultSize('m_gbrain-demo-admin_search', {success: true, output: bigOutput})
        expect(r.output).toBe(bigOutput)
        expect(r.output).not.toContain('[结果已截断]')
    })

    it('mp_ 前缀插件 MCP 工具 20KB 结果不被截断', () => {
        const r = checkResultSize('mp_github_search_repositories', {success: true, output: bigOutput})
        expect(r.output).toBe(bigOutput)
        expect(r.output).not.toContain('[结果已截断]')
    })

    it('list_agents 名册超 15KB 不截断（豁免）', () => {
        const roster = 'x'.repeat(40_000)
        const r = checkResultSize('list_agents', {success: true, output: roster})
        expect(r.output).toBe(roster)
        expect(r.output).not.toContain('[结果已截断]')
    })

    it('普通工具仍受 15KB 截断', () => {
        const r = checkResultSize('grep', {success: true, output: bigOutput})
        expect(r.output).toContain('[结果已截断]')
        expect(r.output.length).toBeLessThan(20_000)
    })

    it('m_ 前缀 130KB 超限时仍截断到 128KB 并带标记', () => {
        const huge = 'y'.repeat(130 * 1024)
        const r = checkResultSize('m_sqlite-mcp_execute', {success: true, output: huge})
        expect(r.output).toContain('[结果已截断]')
        expect(r.output.length).toBeLessThan(130 * 1024)
    })

    it('非字符串输出原样返回', () => {
        const r = checkResultSize('m_foo_bar', {success: true, output: undefined as any})
        expect(r.output).toBeUndefined()
    })

    // ★ catalog 通道：call_mcp_tool 内部委托 MCP proxy，输出与原生 MCP 工具同源，
    //   必须同待遇（128KB 阈值 + 不附加「结果较大」警告尾巴），否则大结果被误砍到 15KB。
    it('call_mcp_tool 20KB 结果不被截断、不加警告尾巴（与原生 MCP 工具一致）', () => {
        const r = checkResultSize('call_mcp_tool', {success: true, output: bigOutput})
        expect(r.output).toBe(bigOutput)
        expect(r.output).not.toContain('[结果已截断]')
        expect(r.output).not.toContain('[警告]')
    })

    it('call_mcp_tool 130KB 超限时按 128KB 阈值截断并带标记', () => {
        const huge = 'y'.repeat(130 * 1024)
        const r = checkResultSize('call_mcp_tool', {success: true, output: huge})
        expect(r.output).toContain('[结果已截断]')
        expect(r.output.length).toBeLessThan(130 * 1024)
    })
})
