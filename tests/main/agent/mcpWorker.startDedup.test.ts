/**
 * MCP Worker 启动去重（single-flight）回归面
 *
 * 背景：`mcpWorker.ts` 的 `startingServers` 是「握手窗口内重复触发同一 server 启动」的唯一闸门。
 * 早期实现把它当 `Set` 用、跳过方直接返回「乐观成功」`{success:true}`，带来两个真实缺陷：
 *   1. 同一 server 在窗口内被两条 `update_servers` 触发时，第二条被静默吞掉且谎报成功；
 *   2. 若第一条最终失败，`init` 的 `backgroundRetry` 会把"被跳过"误判为成功，
 *      从而吞掉该 server 唯一一次重试机会（异常通道全黑）。
 *
 * 现在改为 single-flight：`serverId → 进行中的启动 Promise`，跳过方拿到的是这次启动的真实结果。
 * 本文件锁定该语义（含锁的释放与失败路径，防止退化成去重死锁）。
 *
 * 注：`workerData.servers` 置空，避免顶层 `service.init(configs)` 干扰用例；
 *     每个用例自行 `new McpWorkerService()` 构造独立实例。
 */
import {describe, it, expect, vi, beforeAll, beforeEach} from 'vitest'

type StartResult = {success: boolean; error?: string}

const state = vi.hoisted(() => ({
    /** 每次 startServer 调用的 serverId（用于断言"只启动一次"） */
    startCalls: [] as string[],
    /** 受控 deferred：测试自行决定每次启动何时以何结果结束 */
    pending: [] as Array<{resolve: (v: StartResult) => void; reject: (e: unknown) => void}>,
    postMessages: [] as any[],
}))

vi.mock('worker_threads', () => ({
    parentPort: {
        postMessage: (msg: any) => { state.postMessages.push(msg) },
        on: () => {},
        close: () => {},
    },
    workerData: {servers: []},
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
        isConnected() { return false }
        async stopServer() {}
        startServer(config: any, _maxRetries?: number): Promise<StartResult> {
            state.startCalls.push(config.id)
            return new Promise<StartResult>((resolve, reject) => {
                state.pending.push({resolve, reject})
            })
        }
    },
}))

let McpWorkerService: any

beforeAll(async () => {
    const mod: any = await import('../../../src/main/agent/mcpWorker')
    McpWorkerService = mod.McpWorkerService
    expect(typeof McpWorkerService).toBe('function')
})

const cfgOf = (id: string) => ({id, name: id, transport: 'stdio', enabled: true})

/** 短暂让出事件循环，捕捉"异步后置"才发生的重复启动 */
const flush = () => new Promise(r => setTimeout(r, 20))

describe('mcpWorker 启动去重（single-flight）', () => {
    beforeEach(() => {
        state.startCalls.length = 0
        state.pending.length = 0
        state.postMessages.length = 0
    })

    it('并发两条 update_servers 对同一 server 只启动一次', async () => {
        const svc: any = new McpWorkerService()
        const p1 = svc.handleUpdateServers([cfgOf('s1')])
        const p2 = svc.handleUpdateServers([cfgOf('s1')])

        await vi.waitFor(() => { expect(state.startCalls).toEqual(['s1']) })
        await flush()
        // 第二条被 single-flight 复用，不得再 spawn 一次（重复进程链的直接成因）
        expect(state.startCalls).toEqual(['s1'])

        state.pending[0].resolve({success: true})
        await Promise.all([p1, p2])
    })

    it('启动结束后释放锁，后续 update_servers 能重新启动', async () => {
        const svc: any = new McpWorkerService()
        const p1 = svc.handleUpdateServers([cfgOf('s2')])
        await vi.waitFor(() => { expect(state.startCalls).toEqual(['s2']) })
        state.pending[0].resolve({success: true})
        await p1

        const p2 = svc.handleUpdateServers([cfgOf('s2')])
        await vi.waitFor(() => { expect(state.startCalls).toEqual(['s2', 's2']) })
        state.pending[1].resolve({success: true})
        await p2
    })

    it('startServer reject 后锁仍释放（不去重死锁）', async () => {
        const svc: any = new McpWorkerService()
        const p1 = svc.handleUpdateServers([cfgOf('s3')])
        await vi.waitFor(() => { expect(state.startCalls).toEqual(['s3']) })
        // reject 路径：Promise.allSettled 吞掉异常，但 finally 必须释放 map，否则该 id 永久卡死
        state.pending[0].reject(new Error('boom'))
        await p1

        const p2 = svc.handleUpdateServers([cfgOf('s3')])
        await vi.waitFor(() => { expect(state.startCalls).toEqual(['s3', 's3']) })
        state.pending[1].resolve({success: true})
        await p2
    })

    it('被跳过的调用方拿到与在飞启动一致的真实结果（single-flight 而非乐观成功）', async () => {
        const svc: any = new McpWorkerService()
        const cfg = cfgOf('s4')

        const first = svc.startServerOnce(cfg, 0)
        const second = svc.startServerOnce(cfg, 0)
        expect(state.startCalls).toEqual(['s4'])

        // 在飞启动最终失败 → 跳过方也必须看到 success:false；
        // 若实现返回「乐观成功」，backgroundRetry 会误判已修复并吞掉重试机会。
        state.pending[0].resolve({success: false, error: 'boom'})
        await expect(first).resolves.toEqual({success: false, error: 'boom'})
        await expect(second).resolves.toEqual({success: false, error: 'boom'})
    })
})
