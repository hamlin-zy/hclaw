/**
 * 批 4 · #21 MCPWorkerManager.restartServer 两个新错误分支（fake timers 推 60s 超时）
 *
 * 变异验证记录（批 4）
 * #21 变异：`resolve({success:false, error:'重启超时'})` → `resolve({success:false})`、
 *           `{success:false, error:'服务器不存在'}` → `{success:false}` → 期望红 ✅实测红
 * #21c 变异（批 4 终审修复波）：`mcpWorkerManager.ts:283` `waiter.resolve({ success, error })`
 *      → `waiter.resolve({ success })`（丢弃 error）→ ✅实测红：#21c
 *      （AssertionError: expected { success: false } to deeply equal { success: false, error: 'X' }）
 *      → 已改回，`git diff -- src/main/agent/mcp/mcpWorkerManager.ts` 为空
 * 注：`ipc.ts:18` 的 `fail` 会加 `"Error: "` 前缀（`.rejects` 断言用 `toContain` 而非全等）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

const mockMcpService = vi.hoisted(() => ({
    get: vi.fn(() => undefined as any),
    list: vi.fn(() => [] as any[]),
}))

vi.mock('@/main/services/mcpService', () => ({mcpService: mockMcpService}))
vi.mock('@/main/agent/logger', () => ({
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
}))

import {MCPWorkerManager} from '@/main/agent/mcp/mcpWorkerManager'

describe('批 4 · #21 MCPWorkerManager.restartServer 错误分支', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        mockMcpService.get.mockReset()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('#21a 找不到服务器 → {success:false, error:"服务器不存在"}', async () => {
        mockMcpService.get.mockReturnValue(undefined)
        const m = new MCPWorkerManager()
        await expect(m.restartServer('nope')).resolves.toEqual({
            success: false, error: '服务器不存在',
        })
    })

    it('#21b 60s 超时 → {success:false, error:"重启超时"}', async () => {
        mockMcpService.get.mockReturnValue({id: 's1', name: 's1', transport: 'stdio'})
        const m = new MCPWorkerManager()
        const p = m.restartServer('s1')
        await vi.advanceTimersByTimeAsync(60_000)
        await expect(p).resolves.toEqual({success: false, error: '重启超时'})
    })

    it('#21c restart_complete 的 error 经 handleRestartComplete 透传给 restartServer', async () => {
        mockMcpService.get.mockReturnValue({id: 's1', name: 's1', transport: 'stdio'} as any)
        const m = new MCPWorkerManager()
        // 让 restartServer 认为有 worker 可发消息，从而建立 waiter
        ;(m as any).worker = { postMessage: vi.fn() }
        const p = m.restartServer('s1')
        // 模拟 Worker 回传失败消息（handleRestartComplete 是私有，测试直接调用）
        ;(m as any).handleRestartComplete('s1', false, 'X')
        await expect(p).resolves.toEqual({ success: false, error: 'X' })
    })
})
