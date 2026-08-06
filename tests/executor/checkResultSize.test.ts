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
})
