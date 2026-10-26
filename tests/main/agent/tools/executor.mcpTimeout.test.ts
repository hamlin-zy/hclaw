/**
 * executor 对 MCP 工具的超时放行（「MCP 默认不限时」第 3 层）
 *
 * 背景：executor 的外层 withToolTimeout 与 discovery proxy.execute 的内层
 * withToolTimeout 各自独立计时，最短者先触发。MCP 工具若不从外层跳过，
 * 即便内层与 SDK 层都改成不限时，仍会被 executor 的 DB/默认 60s 打穿。
 *
 * 本文件锁定两条判据：
 *   - shouldSkipOuterTimeout：内置 4 工具 + m_/mp_/mcp_ 前缀 + catalog 包装器 call_mcp_tool
 *     → true；普通工具 → false
 *   - resolveToolTimeoutMs：MCP 工具（含 call_mcp_tool）→ undefined（不显示 24.8 天倒计时）；
 *     bash / web_fetch 仍返回内部超时（防止「跳过外层」误伤成「没有超时」）
 *
 * 变异验证记录（本批）
 * M1 变异：shouldSkipOuterTimeout 去掉 `|| isMcpToolName(toolName)` → ✅实测红
 *    （AssertionError: expected false to be true，m_/mp_/mcp_ 三断言）
 * M2 变异：resolveToolTimeoutMs 删除 `if (isMcpToolName(toolName)) return undefined` → ✅实测红
 *    （expected 60000 to be undefined）
 * M3 变异：shouldSkipOuterTimeout 删除 `|| toolName === MCP_CATALOG_TOOL_NAME` → ✅实测红
 *    （expected false to be true，call_mcp_tool 断言）
 * M4 变异：resolveToolTimeoutMs 的判定去掉 call_mcp_tool → ✅实测红
 *    （expected 60000 to be undefined）
 * 均已还原。
 */
import {describe, expect, it, vi} from 'vitest'
import {resolveToolTimeoutMs, shouldSkipOuterTimeout} from '@/main/agent/tools/executor'

// executor 顶部 import getMcpToolMeta；本文件不测权限链路，按既有做法打桩避免拉起整个 discovery
vi.mock('@/main/agent/mcp/discovery', () => ({
    getMcpToolMeta: vi.fn(),
}))

describe('shouldSkipOuterTimeout（executor 外层超时放行判定）', () => {
    it('内置独立超时/中止工具的 4 个名字 → true', () => {
        for (const name of ['agent', 'ask_user', 'bash', 'web_fetch']) {
            expect(shouldSkipOuterTimeout(name)).toBe(true)
        }
    })

    it('MCP 三前缀（m_ / mp_ / mcp_）→ true', () => {
        expect(shouldSkipOuterTimeout('m_codegraph_explore')).toBe(true)
        expect(shouldSkipOuterTimeout('mp_github_create_issue')).toBe(true)
        expect(shouldSkipOuterTimeout('mcp_abc123_echo')).toBe(true)
    })

    it('catalog 包装器 call_mcp_tool → true（真名在 arguments.name，tool.name 无 MCP 前缀）', () => {
        // 报错现场：工具 "call_mcp_tool" 执行超时（60秒）。catalog 通道下 LLM 调的是
        // 内置包装器，若只按 m_/mp_/mcp_ 前缀判定，外层仍会套 60s 打穿不限时策略。
        expect(shouldSkipOuterTimeout('call_mcp_tool')).toBe(true)
    })

    it('普通工具 → false（不误伤）', () => {
        for (const name of ['read_file', 'grep', 'glob', 'list_agents']) {
            expect(shouldSkipOuterTimeout(name)).toBe(false)
        }
    })

    it('仅前缀字面量、缺下划线的名字 → false（isMcpToolName 的边界）', () => {
        for (const name of ['m', 'mp', 'mcp', 'mail', 'mcpXfoo']) {
            expect(shouldSkipOuterTimeout(name)).toBe(false)
        }
    })
})

describe('resolveToolTimeoutMs（倒计时数据源）', () => {
    it('MCP 工具 → undefined（不限时，无倒计时）', () => {
        expect(resolveToolTimeoutMs('m_codegraph_explore')).toBeUndefined()
        expect(resolveToolTimeoutMs('mp_github_create_issue')).toBeUndefined()
        expect(resolveToolTimeoutMs('mcp_abc123_echo')).toBeUndefined()
    })

    it('catalog 包装器 call_mcp_tool → undefined（不显示 60s 倒计时）', () => {
        expect(resolveToolTimeoutMs('call_mcp_tool', {name: 'm_codegraph_explore', args: {}})).toBeUndefined()
    })

    it('bash / web_fetch 仍返回内部超时（跳过外层 ≠ 没有超时）', () => {
        expect(resolveToolTimeoutMs('bash')).toBe(30000)
        expect(resolveToolTimeoutMs('web_fetch')).toBe(15000)
    })
})
