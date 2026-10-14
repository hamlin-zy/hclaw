// @vitest-environment jsdom
/**
 * MCPEditCard — unknownPolicy 保存语义回归（fail-open 闭合）
 *
 * 回归背景：保存 payload 曾用条件展开 `...(unknownPolicy ? {unknownPolicy} : {})`。
 * 用户把 unknownPolicy 从 'allow' 改回「未配置」时 payload 不含该键 →
 * updateMCPServer 浅合并 `{...s, ...updates}` 保留旧 'allow' → UI 显示「未配置」
 * 但行为仍放行（fail-open 假象，违背本特性保守默认）。
 *
 * 判别力：旧写法下 payload 不含 'unknownPolicy' 键 → 第 1 条用例红；
 *         显式 `unknownPolicy: undefined` 后，浅合并会清除既有值 → 全绿。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, fireEvent} from '@testing-library/react'
import MCPEditCard from '../../../../src/renderer/components/dialogs/MCPEditCard'
import {useMcpStore} from '../../../../src/renderer/stores/mcpStore'

const mcpApiMock = vi.hoisted(() => ({
    list: vi.fn().mockResolvedValue({success: true, data: []}),
    saveServer: vi.fn().mockResolvedValue({success: true}),
    onListChanged: vi.fn(),
    onStatusChanged: vi.fn(),
    onMcpStatusUpdate: vi.fn(),
    getAllStatus: vi.fn().mockResolvedValue([]),
}))

beforeEach(() => {
    vi.stubGlobal('electronAPI', {mcp: mcpApiMock})
    Object.values(mcpApiMock).forEach((fn: any) => fn.mockReset?.())
    mcpApiMock.list.mockResolvedValue({success: true, data: []})
    mcpApiMock.saveServer.mockResolvedValue({success: true})
})

const allowServer = () => ({
    id: 'user-a', name: 'User A', transport: 'stdio' as const, status: 'connected' as const,
    tools: [], enabled: true, command: 'cmd-a', args: [], env: {},
    readOnlyTools: ['codegraph_explore'], writeTools: [], unknownPolicy: 'allow' as const,
})

describe('MCPEditCard unknownPolicy 保存语义', () => {
    it('原 unknownPolicy=allow，表单选「未配置」→ 保存 payload 显式带 unknownPolicy: undefined', () => {
        const onSave = vi.fn()
        render(<MCPEditCard server={allowServer() as any} onSave={onSave} onCancel={() => {}}/>)

        const select = document.querySelector('[data-name="mcpedit-card-unknown-policy-select"]') as HTMLSelectElement
        expect(select.value).toBe('allow')
        fireEvent.change(select, {target: {value: ''}})
        fireEvent.click(document.querySelector('[data-name="mcpedit-card-save-button"]') as HTMLButtonElement)

        expect(onSave).toHaveBeenCalledTimes(1)
        const payload = onSave.mock.calls[0][0]
        // 判别力核心：键必须存在（旧的条件展开写法此处为 false）
        expect(Object.prototype.hasOwnProperty.call(payload, 'unknownPolicy')).toBe(true)
        expect(payload.unknownPolicy).toBeUndefined()
        // 其余策略字段仍按表单值回传
        expect(payload.readOnlyTools).toEqual(['codegraph_explore'])
        expect(payload.writeTools).toEqual([])
    })

    it('payload 经 store.updateMCPServer 浅合并后清除既有 allow（端到端语义闭合）', () => {
        const onSave = vi.fn()
        render(<MCPEditCard server={allowServer() as any} onSave={onSave} onCancel={() => {}}/>)

        const select = document.querySelector('[data-name="mcpedit-card-unknown-policy-select"]') as HTMLSelectElement
        fireEvent.change(select, {target: {value: ''}})
        fireEvent.click(document.querySelector('[data-name="mcpedit-card-save-button"]') as HTMLButtonElement)

        useMcpStore.setState({mcpServers: [allowServer() as any]})
        useMcpStore.getState().updateMCPServer('user-a', onSave.mock.calls[0][0])

        const stored = useMcpStore.getState().mcpServers.find((s: any) => s.id === 'user-a')
        expect(stored?.unknownPolicy).toBeUndefined()
    })
})
