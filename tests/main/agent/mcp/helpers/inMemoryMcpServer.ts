/**
 * in-memory MCP Server 测试夹具（批 2 · Task 6 起）
 *
 * 用途：用 SDK 官方 `InMemoryTransport` 起一个**真实协议**（JSON-RPC over in-memory 双工）
 *       的低层 `Server`，配 `MCPClient` 的 `transportFactory` 注入，从而对 `client.ts`
 *       的连接时序、工具发现、通知处理做黑盒断言，而**不 mock SDK**。
 *
 * 设计约束（与计划 §4 Task 6 对齐）：
 * - 使用低层 `Server`（`@modelcontextprotocol/sdk/server/index.js`），**不用 `McpServer`**，
 *   手动 `setRequestHandler(ListToolsRequestSchema/CallToolRequestSchema, ...)`，**不引入 zod**。
 * - **必须声明 `capabilities.tools`**：`client.ts` 只有在 `serverCapabilities?.tools` 为真时
 *   才会走 listTools 落 state 与 listChanged 注册两条分支。
 * - fixture 工具的 `title` / `annotations` 会**原样**经协议序列化下发，用于 Task 7 的字段裁剪变异。
 * - 本文件**不得出现 `vi.mock`**（真实协议文件，也是后续 mock 文件的对照）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/** 夹具工具：`result` 是 `callTool` 要返回的内容（#3/#4 断言靶） */
export interface FakeTool {
  name: string
  description?: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  /** #2 字段裁剪区分度：必须随协议下发 */
  title?: string
  /** #2 字段裁剪区分度：必须随协议下发 */
  annotations?: Record<string, unknown>
  /** callTool 返回体（#3/#4） */
  result: { content: Array<Record<string, unknown>>; isError?: boolean }
}

export interface InMemoryMcpServerOptions {
  name?: string
  version?: string
  tools?: FakeTool[]
  /** 声明 `capabilities.tools.listChanged`（#5 前置） */
  listChanged?: boolean
}

export interface InMemoryMcpServerHandle {
  clientTransport: import('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport
  serverTransport: import('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport
  server: import('@modelcontextprotocol/sdk/server/index.js').Server
  /** #5 用：替换工具集合（不主动发通知，由调用方决定） */
  setTools(tools: FakeTool[]): void
  /** #5 用：发送 tools/list_changed 通知 */
  sendToolsListChanged(): Promise<void>
}

/** FakeTool → SDK `Tool`（保留 title/annotations，供 #2 裁剪变异） */
function toSdkTool(tool: FakeTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    title: tool.title,
    annotations: tool.annotations,
  } as unknown as Tool
}

/**
 * 起一个 in-memory 低层 MCP Server，返回成对 transport 与句柄。
 * 调用方负责 `await server.connect(serverTransport)` 之后把它接到 `MCPClient`。
 */
export function createInMemoryMcpServer(opts?: InMemoryMcpServerOptions): InMemoryMcpServerHandle {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  let tools: FakeTool[] = opts?.tools ?? []

  const server = new Server(
    { name: opts?.name ?? 'fixture-srv', version: opts?.version ?? '0.0.0' },
    { capabilities: { tools: opts?.listChanged ? { listChanged: true } : {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toSdkTool),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name)
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    }
    return tool.result as { content: Array<Record<string, unknown>>; isError?: boolean }
  })

  return {
    clientTransport,
    serverTransport,
    server,
    setTools(next: FakeTool[]): void {
      tools = next
    },
    async sendToolsListChanged(): Promise<void> {
      await server.sendToolListChanged()
    },
  }
}
