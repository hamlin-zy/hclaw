/**
 * 批 4 · #18 init 首轮失败回归面（P6）
 *
 * ⚠️ 前置（v2.7 / v2.8 写死，否则 ① 不可达）：
 *   - `workerData.servers` 必须**非空且 enabled**（否则 `mcpWorker.ts:188` filter 后 `:192` 循环体一次都不执行）；
 *   - hoisted `startServer` 必须在**模块导入前**恒 `{success:false}` —— `init` 于本文件 `beforeAll` 的
 *     `await import()` 时已一次性执行（`mcpWorker.ts:465-469`），`it` 内切换为时已晚。
 *   - 故 **#18 独立成文件**（`vi.resetModules()` 重导入为不推荐备选）。
 *
 * 变异验证记录（批 4）
 * #18①② 变异：删 `mcpWorker.init` 里的 `if (!r.success)` 判断 → 期望红 ✅实测红
 *      （『首轮失败』log 消失、`failed` 恒空 → 无『后台重试:』log）
 */
import {describe, it, expect, vi, beforeAll} from 'vitest'

const state = vi.hoisted(() => ({
    logs: [] as string[],
    startServerResult: {success: false, error: 'boom'} as {success: boolean; error?: string},
    servers: [{id: 's1', name: 's1', transport: 'stdio', enabled: true}] as any[],
}))

vi.mock('worker_threads', () => ({
    parentPort: {
        postMessage: (msg: any) => {
            if (msg?.type === 'worker_log') state.logs.push(String(msg.args?.[0] ?? ''))
        },
        on: () => {},
        close: () => {},
    },
    workerData: {servers: state.servers},
    MessagePort: class {},
}))

vi.mock('../../../src/main/agent/mcp/client', () => ({
    MCPClient: class {
        constructor(_opts: unknown) {}
        onStatusChange() {}
        getAllServers() { return [] }
        getEffectiveTools() { return [] }
        getServer() { return undefined }
        getServerPid() { return null }
        cleanupStoppedServers() { return 0 }
        async stopServer() {}
        async startServer() { return state.startServerResult }
    },
}))

beforeAll(async () => {
    // 模块副作用：new McpWorkerService() + service.init(configs) + parentPort.on('message', dispatch)
    await import('../../../src/main/agent/mcpWorker')
})

describe('批 4 · #18 init 首轮失败回归面', () => {
    it('#18① 首轮失败写入含「首轮失败」的 worker_log', async () => {
        await vi.waitFor(() => {
            expect(state.logs.some((l) => l.includes('首轮失败'))).toBe(true)
        })
    })

    it('#18② failed 非空 → backgroundRetry 被触发（含「后台重试:」worker_log）', async () => {
        await vi.waitFor(() => {
            expect(state.logs.some((l) => l.includes('后台重试:'))).toBe(true)
        })
    })
})
