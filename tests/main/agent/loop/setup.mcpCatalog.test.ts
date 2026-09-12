/**
 * MCP 工具注入通道（catalog，唯一通道）：装配层过滤单测。
 *
 * catalog 是唯一通道：MCP 工具不进 tools 数组，改由能力目录 + call_mcp_tool 承载，
 * 从而让 tools 前缀不随 MCP server 启停而变动。
 *
 * 覆盖：
 * 1. MCP 工具（m_/mp_/mcp_ 前缀）被移出，call_mcp_tool 追加在尾部
 * 2. 幂等：两条装配产物（available / preCapability）都过滤时不产生重复 call_mcp_tool
 * 3. 上游白名单已移除 call_mcp_tool → 不强行追加（保留 agent 显式白名单的 MCP 工具）
 * 4. 注册异常（def 缺失）→ 不改写列表（异常兜底，退化为原生直调）
 */
import {describe, it, expect} from 'vitest'

import {applyMcpCatalogChannel} from '../../../../src/main/agent/loop/setup'
import {makeToolDefinition} from '../tools/testHelpers'
import type {ToolDefinitionForLLM} from '../../../../src/main/agent/tools/types'

const CALL_MCP_DEF = makeToolDefinition('call_mcp_tool')

const MCP_TOOLS = [
    makeToolDefinition('m_github_create_issue'),
    makeToolDefinition('mp_github_create_or_update_file'),
    makeToolDefinition('mcp_legacy_tool'),
]

const BASE_TOOLS = [
    makeToolDefinition('file_read'),
    makeToolDefinition('bash'),
]

describe('applyMcpCatalogChannel', () => {
    it('★ m_ / mp_ / mcp_ 前缀工具全部移出，call_mcp_tool 追加在尾部', () => {
        // 真实形态：call_mcp_tool 已由 tools/index.ts 无条件注册，故上游列表本就含它
        const input = [...BASE_TOOLS, ...MCP_TOOLS, CALL_MCP_DEF]
        const out = applyMcpCatalogChannel(input, CALL_MCP_DEF)
        expect(out.map(t => t.name)).toEqual(['file_read', 'bash', 'call_mcp_tool'])
        expect(out.some(t => t.name.startsWith('m_') || t.name.startsWith('mp_') || t.name.startsWith('mcp_'))).toBe(false)
    })

    it('重复应用幂等（两条装配产物都过滤时不产生重复项）', () => {
        const once = applyMcpCatalogChannel([...BASE_TOOLS, ...MCP_TOOLS, CALL_MCP_DEF], CALL_MCP_DEF)
        const twice = applyMcpCatalogChannel(once, CALL_MCP_DEF)
        expect(twice.map(t => t.name)).toEqual(['file_read', 'bash', 'call_mcp_tool'])
    })

    it('★ 上游白名单已移除 call_mcp_tool → 不强行追加（该 agent 显式白名单的 MCP 工具保留原生直调）', () => {
        const input = [...BASE_TOOLS, ...MCP_TOOLS]
        const out = applyMcpCatalogChannel(input, CALL_MCP_DEF)
        expect(out.map(t => t.name)).toEqual([
            'file_read', 'bash', 'm_github_create_issue', 'mp_github_create_or_update_file', 'mcp_legacy_tool',
        ])
        expect(out.some(t => t.name === 'call_mcp_tool')).toBe(false)
    })

    it('call_mcp_tool 注册缺失（def 缺失）→ 不改写列表（异常兜底）', () => {
        const input = [...BASE_TOOLS, ...MCP_TOOLS]
        expect(applyMcpCatalogChannel(input, undefined)).toBe(input)
    })
})

describe('装配产物契约（§4.1 两条独立产物）', () => {
    it('availableToolDefinitions 与 preCapabilityToolDefinitions 均不含 MCP 工具，均含 call_mcp_tool', () => {
        const preBase: ToolDefinitionForLLM[] = [...BASE_TOOLS, ...MCP_TOOLS, CALL_MCP_DEF, makeToolDefinition('analyze_image')]
        const pre = applyMcpCatalogChannel(preBase, CALL_MCP_DEF)
        const available = applyMcpCatalogChannel(pre.filter(d => d.name !== 'analyze_image'), CALL_MCP_DEF)
        for (const list of [pre, available]) {
            expect(list.some(t => t.name.startsWith('m_') || t.name.startsWith('mp_') || t.name.startsWith('mcp_'))).toBe(false)
            expect(list.some(t => t.name === 'call_mcp_tool')).toBe(true)
        }
    })
})
