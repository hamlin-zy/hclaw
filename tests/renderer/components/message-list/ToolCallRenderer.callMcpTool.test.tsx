// @vitest-environment jsdom
/**
 * FIX-6: catalog 通道下 call_mcp_tool 的 UI 不能退化成「无信息卡片」。
 *
 * call_mcp_tool 这个工具名不匹配 isMcpToolName，需特判：
 * - 摘要/展示名来自 args.name 指向的真实 MCP 工具名
 * - ToolCallRenderer 的 mcpDisplayName 分支解析出可读的 server_工具名
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import ToolCallRenderer from '../../../../src/renderer/components/message-list/ToolCallRenderer'
import {getToolSummary, getToolArgSummary, getToolDetail} from '../../../../src/renderer/components/message-list/utils/messageUtils'

const MCP_SERVERS = [{id: 'github', name: 'github', tools: [{name: 'create_issue'}]}]

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: unknown) => unknown) => selector({
        messageDisplayMode: 'detailed',
        openToolPopup: vi.fn(),
        openCombinedPopup: vi.fn(),
    }),
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: unknown) => unknown) => selector({activeConversationId: null}),
}))

vi.mock('../../../../src/renderer/stores/mcpStore', () => ({
    useMcpStore: (selector: (s: unknown) => unknown) => selector({mcpServers: MCP_SERVERS}),
}))

vi.mock('../../../../src/renderer/stores/modelSchemeStore', () => ({
    useModelSchemeStore: (selector: (s: unknown) => unknown) => selector({schemes: [], activeSchemeId: null}),
}))

vi.mock('../../../../src/renderer/stores/llmStore', () => ({
    useLLMStore: {getState: () => ({providers: []})},
}))

const TOOL_CALL = {
    id: 'tc-mcp-1',
    name: 'call_mcp_tool',
    arguments: {name: 'm_github_create_issue', args: {repo: 'a/b', title: 't'}},
    status: 'success' as const,
    result: {output: 'ok'},
}

describe('messageUtils 对 call_mcp_tool 的摘要（FIX-6）', () => {
    it('getToolSummary / getToolArgSummary 返回真实 MCP 工具名', () => {
        expect(getToolSummary(TOOL_CALL as any)).toBe('m_github_create_issue')
        expect(getToolArgSummary(TOOL_CALL as any)).toBe('m_github_create_issue')
    })

    it('getToolDetail 包含目标 MCP 工具名', () => {
        expect(getToolDetail(TOOL_CALL as any)).toContain('m_github_create_issue')
    })
})

describe('ToolCallRenderer call_mcp_tool 卡片（FIX-6）', () => {
    it('展示真实 MCP 工具名（非 call_mcp_tool 占位）', () => {
        render(<ToolCallRenderer toolCall={TOOL_CALL as any}/>)

        // 摘要区展示 args.name
        expect(screen.getByText('m_github_create_issue')).toBeTruthy()
        // 头部展示名被解析为 server + 工具名
        expect(document.body.textContent).toContain('github')
        expect(document.body.textContent).toContain('create_issue')
    })
})
