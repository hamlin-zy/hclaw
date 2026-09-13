// 最小 MCP stdio server（批 2 · Task 11 真实 stdio fixture）
//
// 用途：`client.processController.test.ts` 用真实子进程验证 PID 闭环与默认进程装配。
// 启动方式：`node tests/fixtures/minimalMcpServer.mjs`（由 StdioClientTransport 拉起）。
//
// ⚠️ 硬约束：**stdout 是 JSON-RPC 帧通道**，任何调试输出必须走 stderr，
//    否则会污染协议流导致握手失败。
//
// ESM（.mjs，即使 package.json 为 commonjs）。裸模块名由 Node 从本文件位置
// 逐级向上找 node_modules 解析（tests/fixtures → tests → 仓库根/node_modules）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'minimal-fixture', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'echo back the given message',
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: String(req.params.arguments?.msg ?? '') }],
}))

try {
  await server.connect(new StdioServerTransport())
  // 仅诊断用；走 stderr，绝不碰 stdout
  process.stderr.write('[minimal-fixture] connected\n')
} catch (err) {
  process.stderr.write(`[minimal-fixture] fatal: ${err?.stack ?? err}\n`)
  process.exit(1)
}
