/**
 * MCPClient · callTool 取消信号透传（V2）
 *
 * 背景：`sdkClient.callTool(payload, undefined, {timeout})` 未传 signal，
 * discovery 的 raceAbort 只结算外层 Promise，SDK 侧请求上下文与回包继续驻留。
 *
 * 关键约束：SDK 注册的 abort 监听器从不 removeEventListener（protocol.js 全文件无
 * removeEventListener）。因此**不得**把 run 级长期 signal 直接交给 SDK —— client.ts
 * 必须为每次调用新建 AbortController + 桥接监听器（{once:true}）并在 finally 摘除。
 *
 * 本文件断言：
 *   #1 第 4 参 signal 桥接进 SDK options.signal（且不等于原始 run signal）
 *   #2 调用正常结束后，外部 signal 上的 abort 监听器数为 0（桥接监听器已摘除）
 *   #3 外部 abort → SDK 请求真终结（远早于服务端 5s 延迟）
 */
import {describe, it, expect, vi} from 'vitest'
import {getEventListeners} from 'node:events'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js'
import {MCPClient} from '@/main/agent/mcp/client'
import type {ClientTransport} from '@/main/agent/mcp/client'
import type {MCPServerConfig} from '@/main/agent/mcp/types'

/** 起一个延迟 N 毫秒才返回的 in-memory server（同 client.callToolTimeout.test.ts 夹具） */
async function createDelayingServer(delayMs: number) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = new Server(
        {name: 'delaying-srv', version: '0.0.0'},
        {capabilities: {tools: {}}},
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{name: 'slow', description: '延迟返回', inputSchema: {type: 'object', properties: {}}}],
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => {
        await new Promise((r) => setTimeout(r, delayMs))
        return {content: [{type: 'text', text: 'done'}]}
    })
    await server.connect(serverTransport)
    return {clientTransport, server, close: () => server.close()}
}

function makeCfg(id: string): MCPServerConfig {
    return {id, name: 'fixture', transport: 'stdio', enabled: true}
}

function sdkClientOf(client: MCPClient, id: string) {
    return (client as unknown as {
        servers: Map<string, {sdkClient?: {callTool: (...a: unknown[]) => Promise<unknown>}}>
    }).servers.get(id)!.sdkClient!
}

describe('MCPClient · callTool signal 透传（per-call AbortController）', () => {
    it('#1 第 4 参 signal 桥接进 SDK options；#3 abort 后请求真终结', async () => {
        const cfg = makeCfg('srv-signal-abort')
        const fixture = await createDelayingServer(5000)
        const client = new MCPClient({
            transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
        })
        await client.connect(cfg)

        const sdk = sdkClientOf(client, cfg.id)
        const spy = vi.spyOn(sdk, 'callTool')

        const runController = new AbortController()
        const startedAt = Date.now()
        const pending = client.callTool(cfg.id, 'slow', {}, runController.signal)

        // #1：SDK 的 options 带 signal，但必须是内部 per-call controller，而不是 run 级 signal
        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
        const options = spy.mock.calls[0][2] as {timeout?: number; signal?: AbortSignal}
        expect(options.signal).toBeInstanceOf(AbortSignal)
        expect(options.signal).not.toBe(runController.signal)
        expect(options.signal!.aborted).toBe(false)
        expect(options.timeout).toBeTypeOf('number')

        // #3：外部 abort → SDK 协议层 reject（远早于 5s 服务端延迟）
        runController.abort()
        await expect(pending).rejects.toBeDefined()
        expect(Date.now() - startedAt).toBeLessThan(1500)

        await client.stopServer(cfg.id)
        await fixture.close()
    })

    it('#2 正常返回后摘除外部 signal 上的桥接监听器（SDK 不摘，必须自己摘）', async () => {
        const cfg = makeCfg('srv-signal-cleanup')
        const fixture = await createDelayingServer(100)
        const client = new MCPClient({
            transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
        })
        await client.connect(cfg)

        const runController = new AbortController()
        expect(getEventListeners(runController.signal, 'abort')).toHaveLength(0)

        const pending = client.callTool(cfg.id, 'slow', {}, runController.signal)
        await vi.waitFor(() =>
            expect(getEventListeners(runController.signal, 'abort')).toHaveLength(1),
        )

        const result = await pending
        expect(result.content[0]).toEqual({type: 'text', text: 'done'})
        // 调用结束（未 abort，{once:true} 不会自动摘）→ 必须由 finally removeEventListener
        expect(getEventListeners(runController.signal, 'abort')).toHaveLength(0)

        await client.stopServer(cfg.id)
        await fixture.close()
    })

    it('#2b 无 signal 时行为不变：调用正常完成且不产生额外监听器', async () => {
        const cfg = makeCfg('srv-signal-none')
        const fixture = await createDelayingServer(20)
        const client = new MCPClient({
            transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
        })
        await client.connect(cfg)

        const result = await client.callTool(cfg.id, 'slow', {})
        expect(result.content[0]).toEqual({type: 'text', text: 'done'})

        await client.stopServer(cfg.id)
        await fixture.close()
    })
})
