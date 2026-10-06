/**
 * MCPWorkerManager PID 追踪回归面（trackedPids）
 *
 * 背景：`trackedPids` 是「Worker 崩溃 / 应用退出后仍能清掉 MCP 子进程」的唯一线索来源。
 * 两个真实缺陷被本文件锁定：
 *  1. `pid_info: null` 曾直接 `trackedPids.delete(serverId)` —— 而每次重连都会经
 *     stopped/disconnected 上报一次 null，等于每次重连都把该 server 名下**仍存活的残留 PID**
 *     一起丢弃，清理线索永久失联；
 *  2. 同一 server 名下可能短暂存在多个子进程（重复启动的残留），必须累加式记录、逐个清理。
 *
 * ⚠️ 严禁真实执行 taskkill：`child_process.execSync` 与 `isProcessRunning` 均被 mock。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const mocks = vi.hoisted(() => ({
    execSync: vi.fn(),
    isProcessRunning: vi.fn((_pid: number) => true),
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
    mcpService: {get: vi.fn(() => undefined as any), list: vi.fn(() => [] as any[])},
}))

// 保留 child_process 的其余导出，仅拦截会真实杀进程的 execSync
vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    execSync: mocks.execSync,
}))

vi.mock('@/main/agent/mcp/transport/processUtils', () => ({
    isProcessRunning: mocks.isProcessRunning,
    waitForProcessExit: vi.fn(async () => true),
}))

vi.mock('@/main/agent/logger', () => ({logger: mocks.logger}))
vi.mock('@/main/services/mcpService', () => ({mcpService: mocks.mcpService}))

import {MCPWorkerManager} from '@/main/agent/mcp/mcpWorkerManager'

/** 取回所有 taskkill 命令文本 */
function killCommands(): string[] {
    return mocks.execSync.mock.calls.map((c: any[]) => String(c[0]))
}

describe('MCPWorkerManager.trackedPids（残留 PID 追踪与回收）', () => {
    beforeEach(() => {
        mocks.execSync.mockClear()
        mocks.isProcessRunning.mockReset()
        mocks.isProcessRunning.mockImplementation(() => true)
    })

    it('pid_info 上报 null 后不清空仍存活的 PID', () => {
        const m = new MCPWorkerManager()
        // updateTrackedPid 是私有成员，按仓库既有测试惯例用 (m as any) 访问
        // （见 tests/main/agent/mcp/mcpWorkerManager.restart.test.ts 的 handleRestartComplete）
        ;(m as any).updateTrackedPid('s1', 1234)
        // 重连路径：stopped/disconnected 会上报一次 pid=null
        ;(m as any).updateTrackedPid('s1', null)

        m.forceKillAllPids()

        expect(killCommands().some(c => c.includes('1234'))).toBe(true)
    })

    it('同一 server 的多个 PID 都会被清理（累加式）', () => {
        const m = new MCPWorkerManager()
        ;(m as any).updateTrackedPid('s1', 111)
        ;(m as any).updateTrackedPid('s1', 222)

        m.forceKillAllPids()

        const cmds = killCommands()
        expect(cmds.some(c => c.includes('111'))).toBe(true)
        expect(cmds.some(c => c.includes('222'))).toBe(true)
    })

    it('已退出的 PID 在下次上报时被剔除，不再产生清理命令', () => {
        const m = new MCPWorkerManager()
        ;(m as any).updateTrackedPid('s1', 111)   // 加入时不判活（此时集合为空）
        // 111 已被系统回收 → 下一次上报把它剔除，避免集合无界增长、清理被死 PID 拖慢
        mocks.isProcessRunning.mockImplementation((pid: number) => pid !== 111)
        ;(m as any).updateTrackedPid('s1', 222)

        m.forceKillAllPids()

        const cmds = killCommands()
        expect(cmds.some(c => c.includes('222'))).toBe(true)
        expect(cmds.some(c => c.includes('111'))).toBe(false)
    })
})
