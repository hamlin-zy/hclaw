/**
 * MCPClient · callTool 运行期超时透传（config.timeout → SDK request timeout）
 *
 * 背景：`client.ts` 的 callTool 原先调 `sdkClient.callTool(params)` 不传 options，
 * 运行期永远吃 SDK 内建 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60s`，
 * `MCPServerConfig.timeout`（MCP 编辑卡片「高级配置 → 超时」）对工具调用完全无效
 * ——types.ts MCPTransportOptions.requestTimeout 的注释早已声明这一缺口。
 *
 * 本文件断言三条行为（全部经公开 API + 真实 SDK 协议观测，不 mock SDK）：
 *   #1 config.timeout 显式值透传给 SDK（慢工具在短超时下以 RequestTimeout 失败）
 *   #2 config.timeout 缺省 → 不限时哨兵：慢工具正常完成（对照组）
 *   #3 超上限值（> 2^31-1）被 clamp，不会因 Node setTimeout clamp 成 1ms 而立即失败
 *
 * 夹具：`helpers/inMemoryMcpServer` 的 FakeTool 只支持同步 `result`，
 * 无法表达「延迟 N 毫秒后返回」，故本文件在 server 侧另起一个可延迟的 handler
 * ——不改共享夹具（避免污染其他测试的 result 契约）。
 *
 * 变异验证记录（本批）
 * M1 变异：删 callTool 的 options 第三参 `{ timeout: ... }`
 *    → #1 期望红（AssertionError: expected [McpError: MCP error -32002: Request timed out]
 *      to be undefined）✅实测红
 *    → 已改回，`git diff -- src/` 为空
 * M2 变异：getTransportOptions 的 requestTimeout 去掉 Math.min clamp
 *    → #3 期望红（AssertionError: expected [McpError: MCP error -32002: Request timed out]
 *      to be undefined）✅实测红
 *    → 已改回，`git diff -- src/` 为空
 */
import { describe, it, expect, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { MCPClient } from '@/main/agent/mcp/client'
import type { ClientTransport } from '@/main/agent/mcp/client'
import type { MCPServerConfig } from '@/main/agent/mcp/types'

/** 主进程侧 client.ts 的 MAX_REQUEST_TIMEOUT_MS（2^31-1），单测需同源故在此复述 */
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647

/**
 * 起一个「延迟 N 毫秒才返回」的 in-memory server。
 *
 * 为什么不用 helpers/inMemoryMcpServer：其 FakeTool.result 是同步值，
 * 无法构造「调用未在超时窗口内完成」的场景（本文件的核心断言）。
 */
async function createDelayingServer(delayMs: number) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new Server(
    { name: 'delaying-srv', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'slow',
        description: '延迟返回',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async () => {
    await new Promise((r) => setTimeout(r, delayMs))
    return { content: [{ type: 'text', text: 'done' }] }
  })
  await server.connect(serverTransport)
  return { clientTransport, server, close: () => server.close() }
}

describe('MCPClient · callTool 运行期超时透传', () => {
  it('#1 config.timeout 显式值生效：慢工具在短超时下以 RequestTimeout 失败', async () => {
    // 工具延迟 500ms，超时设 30ms → 必须超时。
    // 若 options 未透传（SDK 60s 默认），本调用会成功返回 'done' → 断言失败。
    const cfg: MCPServerConfig = {
      id: 'srv-timeout-explicit',
      name: 'fixture',
      transport: 'stdio',
      enabled: true,
      timeout: 30,
    }
    const fixture = await createDelayingServer(500)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    // SDK 的 RequestTimeout 走 McpError（code -32002），message 含 'Request timed out'
    await expect(client.callTool('srv-timeout-explicit', 'slow', {})).rejects.toThrow(
      /Request timed out/,
    )

    await client.stopServer('srv-timeout-explicit')
    await fixture.close()
  })

  it('#2 config.timeout 缺省 → 不限时哨兵：慢工具（500ms）正常完成', async () => {
    // 对照组：未配 timeout 时不得被误伤（证明 #1 的红来自显式超时，而非夹具本身有问题）
    const cfg: MCPServerConfig = {
      id: 'srv-timeout-default',
      name: 'fixture',
      transport: 'stdio',
      enabled: true,
    }
    const fixture = await createDelayingServer(500)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    const r = await client.callTool('srv-timeout-default', 'slow', {})
    expect(r.content[0]).toEqual({ type: 'text', text: 'done' })

    await client.stopServer('srv-timeout-default')
    await fixture.close()
  })

  it('#3 超过 setTimeout 上限的值被 clamp：慢工具不因 1ms clamp 而立即失败', async () => {
    // Node 的 setTimeout delay > 2^31-1 会被 clamp 成 1ms → 立即触发超时。
    // 若客户端不做 Math.min clamp，配 3e9（≈95 年）会让调用瞬间失败。
    const cfg: MCPServerConfig = {
      id: 'srv-timeout-huge',
      name: 'fixture',
      transport: 'stdio',
      enabled: true,
      timeout: 3_000_000_000,
    }
    const fixture = await createDelayingServer(200)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    const r = await client.callTool('srv-timeout-huge', 'slow', {})
    expect(r.content[0]).toEqual({ type: 'text', text: 'done' })

    await client.stopServer('srv-timeout-huge')
    await fixture.close()
  })

  it('#4 clamp 边界：恰为上限值可直接配置且不干扰正常调用', async () => {
    // 上限值本身合法（≈24.8 天，UI max 与此同源），不得被 clamp 成更小值而误伤
    const cfg: MCPServerConfig = {
      id: 'srv-timeout-max',
      name: 'fixture',
      transport: 'stdio',
      enabled: true,
      timeout: MAX_REQUEST_TIMEOUT_MS,
    }
    const fixture = await createDelayingServer(50)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    const r = await client.callTool('srv-timeout-max', 'slow', {})
    expect(r.content[0]).toEqual({ type: 'text', text: 'done' })

    await client.stopServer('srv-timeout-max')
    await fixture.close()
  })

  it('#5 clamp 收敛点是 SDK 收到的值本身：spy 断言第三参 timeout', async () => {
    // 直接观测 SDK 收到的 options.timeout，比「跑真实延迟」更精确：
    // 覆盖「传了但传错值」这类回归（例如误传 connectTimeout）。
    const cfg: MCPServerConfig = {
      id: 'srv-timeout-spy',
      name: 'fixture',
      transport: 'stdio',
      enabled: true,
      timeout: 123_456,
    }
    const fixture = await createDelayingServer(0)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    // 经 getServer() 拿不到 sdkClient（不在快照内）→ 用私有字段访问（测试接缝）
    const sdkClient = (client as unknown as {
      servers: Map<string, { sdkClient?: { callTool: (...a: unknown[]) => Promise<unknown> } }>
    }).servers.get('srv-timeout-spy')!.sdkClient!
    const spy = vi.spyOn(sdkClient, 'callTool')

    await client.callTool('srv-timeout-spy', 'slow', {})

    expect(spy).toHaveBeenCalledTimes(1)
    const third = spy.mock.calls[0][2] as { timeout?: number }
    expect(third).toEqual({ timeout: 123_456 })
    expect(third.timeout).not.toBe(15_000) // 不得误用 connectTimeout

    await client.stopServer('srv-timeout-spy')
    await fixture.close()
  })
})
