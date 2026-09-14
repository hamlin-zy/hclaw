/**
 * MCPClient · in-memory 真实协议测试（批 2）
 *
 * 用 SDK 官方 `InMemoryTransport` 起真实 JSON-RPC 双工，对 `MCPClient` 做黑盒断言。
 * **本文件不得出现 `vi.mock`** —— 它是「真实协议」文件，也是后续 mock 文件的对照。
 *
 * 步 2 总纪律：本批没有 TDD 意义上的 red-green（接缝是测试前提），
 * 故每条用例写完必须**故意改坏 `src/` 实现**确认用例变红，再改回。
 *
 * 变异验证记录（批 2）
 * #1  变异：注释掉 `client.ts:229` `connect()` 内首次 `this.emitStatusChange(config.id, ...)`
 *     → 期望 `emitted` 变为 ['connecting','connected']（长度 2）→ ✅实测红
 *       （AssertionError: expected [ 'connecting', 'connected' ] to deeply equal
 *        [ 'connecting', 'connecting', 'connected' ]）→ 已改回，`git diff` 为空
 * #2  变异：`sdkAdapter.ts:27-31` toMcpToolDefinition 改为 `return { ...tool } as unknown as MCPToolDefinition`
 *     （透传全部字段，删裁剪）→ 期望键集变 5 个 → ✅实测红
 *       （AssertionError: expected [ 'annotations', 'description', …(3) ] to deeply equal [ Array(3) ]）
 *       备注：SDK types.js 的 `ToolSchema`（:1229）含 title/annotations，字段确实随真实协议下发 → 变异有区分度
 *       → 已改回，`git diff` 为空
 * #3  变异：`sdkAdapter.ts:58` `text: c.text` → `text: ''` → 期望 content[0].text 失配 → ✅实测红
 *       （AssertionError: expected { type: 'text', text: '' } to deeply equal { type: 'text', text: '预期值' }）
 *       → 已改回，`git diff` 为空
 * #4  变异：删 `sdkAdapter.ts:67` 的兜底 `return { type: 'text', text: '' }`（改返回 undefined）→ ✅实测红
 *       （AssertionError: expected undefined to deeply equal { type: 'text', text: '' }）→ 已改回，`git diff` 为空
 * #5  变异：删 `client.ts:316-317` 的 `const { tools } = await sdkClient.listTools(); state.tools = tools.map(...)`
 *     （handler 只保留 emit）→ 期望 emit 携带旧列表 → ✅实测红
 *       （vi.waitFor timeout 3000ms：AssertionError: expected [ 'echo' ] to deeply equal [ 'echo', 'echo2' ]）
 *       → 已改回，`git diff` 为空
 * #13 变异：`client.ts:502` `getEffectiveTools` 的 `return state.tools.filter(t => !this.isToolDenied(serverId, t.name))`
 *     改为 `return state.tools`（删过滤；保留 :501 的 `if (!denied.length)` 早退分支以免失去区分度）→ ✅实测红
 *       （AssertionError: expected [ 'echo', 'safe' ] to deeply equal [ 'safe' ]）→ 已改回，`git diff` 为空
 * #10 变异①：删 `client.ts:144` stopServer 内 `state.tools = []`（保留 resources 清空）→ ✅实测红
 *       （AssertionError: expected [ { name: 'echo', …(2) } ] to deeply equal []）→ 已改回，`git diff` 为空
 *     变异②：删 `client.ts:435` cleanupStoppedServers 内 `this.servers.delete(id)`（保留 statusListeners.delete）
 *       → ✅实测红（主判据 getServer()===undefined 失败：
 *        AssertionError: expected { Object (config, status, ...) } to be undefined）
 *       辅判据 `removed === 1` 对变异②不敏感（符合计划预期）；已改回，`git diff` 为空
 */
import { describe, it, expect, vi } from 'vitest'
import { MCPClient } from '@/main/agent/mcp/client'
import type { ClientTransport } from '@/main/agent/mcp/client'
import type { MCPServerConfig } from '@/main/agent/mcp/types'
import { createInMemoryMcpServer } from './helpers/inMemoryMcpServer'

describe('MCPClient · in-memory (#1 connect 状态序列 + getServer 快照)', () => {
  it('#1 connect 依次 emit connecting→connecting→connected，且 transportFactory 晚于首次 emit', async () => {
    const cfg: MCPServerConfig = { id: 'srv-1', name: 'fixture', transport: 'stdio', enabled: true }
    const order: string[] = []
    const fixture = createInMemoryMcpServer({
      name: 'fixture-srv',
      version: '9.9.9',
      tools: [
        {
          name: 'echo',
          description: '回显',
          inputSchema: { type: 'object', properties: {} },
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
    })
    await fixture.server.connect(fixture.serverTransport)

    const emitted: string[] = []
    const client = new MCPClient({
      transportFactory: (c) => {
        order.push('factory:' + c.id)
        // InMemoryTransport 不在 ClientTransport 联合内（见计划 F4）；仅测试注入，故断言式转换。
        return fixture.clientTransport as unknown as ClientTransport
      },
    })
    client.onStatusChange('srv-1', (s) => {
      order.push('emit:' + s.status)
      emitted.push(s.status)
    })

    await client.connect(cfg)

    expect(emitted).toEqual(['connecting', 'connecting', 'connected'])
    expect(order[0]).toBe('emit:connecting') // 首次 emit 早于 transportFactory
    expect(order.indexOf('emit:connecting')).toBeLessThan(order.indexOf('factory:srv-1'))

    const snap = client.getServer('srv-1')!
    expect(snap.status).toBe('connected')
    expect(snap.serverInfo?.name).toBe('fixture-srv')
    expect(snap.serverInfo?.version).toBe('9.9.9')
    expect(snap.tools.map((t) => t.name)).toEqual(['echo'])

    await client.stopServer('srv-1')
    expect(client.isConnected('srv-1')).toBe(false)
    await fixture.server.close()
  })
})

describe('MCPClient · in-memory 组 A 剩余（#2 listTools 裁剪 / #3 callTool / #4 占位 / #5 list_changed）', () => {
  it('#2 listTools 落 state，且 toMcpToolDefinition 只保留 name/description/inputSchema（裁掉 title/annotations）', async () => {
    const cfg: MCPServerConfig = { id: 'srv-2', name: 'fixture', transport: 'stdio', enabled: true }
    const fixture = createInMemoryMcpServer({
      tools: [
        {
          name: 'echo',
          description: '回显',
          inputSchema: { type: 'object', properties: {} },
          // 裁剪区分度：这两个字段必须随协议下发，否则变异前后键集相同（见计划 §4 Task 7 #2）
          title: 'Echo Tool',
          annotations: { readOnlyHint: true },
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
    })
    await fixture.server.connect(fixture.serverTransport)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    const snap = client.getServer('srv-2')!
    expect(snap.tools.map((t) => t.name)).toEqual(['echo'])
    const t = snap.tools[0]
    expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name'])
    expect((t as any).title).toBeUndefined()
    expect((t as any).annotations).toBeUndefined()

    await client.stopServer('srv-2')
    expect(client.getServer('srv-2')!.status).toBe('stopped')
    await fixture.server.close()
  })

  it('#3 callTool 走真实协议并映射为 MCPToolCallResult（text 内容 + isError=false）', async () => {
    const cfg: MCPServerConfig = { id: 'srv-3', name: 'fixture', transport: 'stdio', enabled: true }
    const fixture = createInMemoryMcpServer({
      tools: [
        {
          name: 'echo',
          description: '回显',
          inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
          result: { content: [{ type: 'text', text: '预期值' }] },
        },
      ],
    })
    await fixture.server.connect(fixture.serverTransport)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    const r = await client.callTool('srv-3', 'echo', { msg: 'hi' })
    expect(r.content[0]).toEqual({ type: 'text', text: '预期值' })
    expect(r.isError).toBe(false)

    await client.stopServer('srv-3')
    expect(client.isConnected('srv-3')).toBe(false)
    await fixture.server.close()
  })

  it('#4 AudioContent / ResourceLink → 空 text 占位（HClaw 不支持的类型不丢失 content 槽位）', async () => {
    const cfg: MCPServerConfig = { id: 'srv-4', name: 'fixture', transport: 'stdio', enabled: true }
    const fixture = createInMemoryMcpServer({
      tools: [
        {
          name: 'audioEcho',
          inputSchema: { type: 'object', properties: {} },
          result: { content: [{ type: 'audio', data: 'AQID', mimeType: 'audio/wav' }] },
        },
        {
          name: 'linkEcho',
          inputSchema: { type: 'object', properties: {} },
          // 注意：SDK 的 ResourceLinkSchema 判别字面量是 `resource_link`（snake_case）
          result: { content: [{ type: 'resource_link', uri: 'file:///x', name: 'x', mimeType: 'text/plain' }] },
        },
      ],
    })
    await fixture.server.connect(fixture.serverTransport)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    expect((await client.callTool('srv-4', 'audioEcho', {})).content[0]).toEqual({ type: 'text', text: '' })
    expect((await client.callTool('srv-4', 'linkEcho', {})).content[0]).toEqual({ type: 'text', text: '' })

    await client.stopServer('srv-4')
    expect(client.isConnected('srv-4')).toBe(false)
    await fixture.server.close()
  })

  it('#5 tools/list_changed → 重拉工具列表并 emit（重拉先于 emit）', async () => {
    const cfg: MCPServerConfig = { id: 'srv-5', name: 'fixture', transport: 'stdio', enabled: true }
    const echoTool = {
      name: 'echo',
      description: '回显',
      inputSchema: { type: 'object' as const, properties: {} },
      result: { content: [{ type: 'text', text: 'ok' }] },
    }
    // 前置（不写必红）：必须声明 capabilities.tools.listChanged，否则 client.ts:311 的
    // if (serverCapabilities?.tools?.listChanged) 不成立，handler 根本不会注册
    const fixture = createInMemoryMcpServer({ listChanged: true, tools: [echoTool] })
    await fixture.server.connect(fixture.serverTransport)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)
    expect(client.getServer('srv-5')!.tools.map((t) => t.name)).toEqual(['echo'])

    const events: Array<{ tools: string[] }> = []
    client.onStatusChange('srv-5', (s) => events.push({ tools: s.tools.map((t) => t.name) }))
    expect(events.length).toBe(0) // 订阅后、通知前无 emit

    fixture.setTools([echoTool, { ...echoTool, name: 'echo2' }])
    await fixture.sendToolsListChanged()

    await vi.waitFor(() => expect(events[events.length - 1]?.tools).toEqual(['echo', 'echo2']), {
      timeout: 3000,
      interval: 50,
    })
    // 精确断言：末次 emit 时 tools 已是新列表，且 state.tools 同步为新列表 → 证明「重拉先于 emit」
    expect(events[events.length - 1]!.tools).toEqual(['echo', 'echo2'])
    expect(client.getServer('srv-5')!.tools.map((t) => t.name)).toEqual(['echo', 'echo2'])

    await client.stopServer('srv-5')
    expect(client.isConnected('srv-5')).toBe(false)
    await fixture.server.close()
  })
})

describe('MCPClient · in-memory #13 denyList/autoApprove 真实逻辑（黑盒经公开方法）', () => {
  it('#13 denyList 过滤工具 + autoApprove 判定，全部经公开方法观测', async () => {
    const cfg: MCPServerConfig = {
      id: 'srv-denied',
      name: 'fixture',
      transport: 'stdio',
      enabled: true,
      denyList: ['echo'],
      autoApprove: ['safe'],
    }
    const fixture = createInMemoryMcpServer({
      tools: [
        {
          name: 'echo',
          inputSchema: { type: 'object', properties: {} },
          result: { content: [{ type: 'text', text: 'echo' }] },
        },
        {
          name: 'safe',
          inputSchema: { type: 'object', properties: {} },
          result: { content: [{ type: 'text', text: 'safe' }] },
        },
      ],
    })
    await fixture.server.connect(fixture.serverTransport)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)

    // 未过滤基线：两个工具都已发现（证明过滤是 denyList 生效的结果，而非工具缺失）
    // （原 getAllToolDefinitions().get(id)!.tools 的等价公开路径 = getServer(id)!.tools）
    const allToolNames = client.getServer('srv-denied')!.tools.map((t) => t.name)
    expect(allToolNames).toEqual(['echo', 'safe'])
    // deny 判定
    expect(client.isToolDenied('srv-denied', 'echo')).toBe(true)
    expect(client.isToolDenied('srv-denied', 'safe')).toBe(false)
    // deny 过滤 + deny 差集：
    //   原 getEffectiveTools(...) 与 getAllToolDefinitions(true).get(id)! 均等价于 getEffectiveTools(id)
    //   原 getDeniedToolNames('srv-denied') === ['echo'] 的语义等价改写 = 「已发现集 − 有效集」的差集
    const effectiveNames = client.getEffectiveTools('srv-denied').map((t) => t.name)
    expect(effectiveNames).toEqual(['safe'])
    expect(allToolNames.filter((n) => !effectiveNames.includes(n))).toEqual(['echo'])
    // autoApprove 判定
    expect(client.isToolAutoApproved('srv-denied', 'safe')).toBe(true)
    expect(client.isToolAutoApproved('srv-denied', 'echo')).toBe(false)

    await client.stopServer('srv-denied')
    expect(client.isConnected('srv-denied')).toBe(false)
    await fixture.server.close()
  })
})

describe('MCPClient · in-memory #10 stopServer 语义 + cleanupStoppedServers 删除', () => {
  it('#10 stopServer 保留 state 但清空 tools/resources；已停止满 5 分钟后 cleanupStoppedServers 才删除 state', async () => {
    // ⚠️ 批 3 兼容：本用例只经 connect / stopServer / cleanupStoppedServers 公开方法，
    //    不直接调 disconnect（批 3 P4 会把 disconnect 转 private）。
    const cfg: MCPServerConfig = { id: 'srv-10', name: 'fixture', transport: 'stdio', enabled: true }
    const fixture = createInMemoryMcpServer({
      tools: [
        {
          name: 'echo',
          inputSchema: { type: 'object', properties: {} },
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
      ],
    })
    await fixture.server.connect(fixture.serverTransport)

    const base = Date.now() // 在 stopServer 之前取（stopServer 会用真实时钟写 stoppedTime）
    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    await client.connect(cfg)
    // 前置：已发现工具 → stopServer 的清空才有区分度
    expect(client.getServer('srv-10')!.tools.map((t) => t.name)).toEqual(['echo'])

    await client.stopServer('srv-10')

    // ① stopServer 段：不删 state、不清 listener；只清 tools/resources 并置 stopped
    const snap = client.getServer('srv-10')
    expect(snap).toBeDefined() // 不删 state
    expect(snap!.status).toBe('stopped')
    expect(snap!.tools).toEqual([])
    expect(snap!.resources).toEqual([])
    expect(client.isConnected('srv-10')).toBe(false)
    // 不得断言 sdkClient/sdkTransport/stoppedTime：不在 getServer() 快照内，黑盒不可观测

    // ② cleanupStoppedServers 段：推进假时钟（⚠️ 必须显式 setSystemTime，见计划 §8 F5）
    vi.useFakeTimers()
    vi.setSystemTime(base + 6 * 60 * 1000)
    try {
      const removed = client.cleanupStoppedServers()
      expect(client.getServer('srv-10')).toBeUndefined() // 主判据：this.servers.delete(id)
      expect(removed).toBe(1) // 辅判据：toRemove.length（删 servers.delete 后仍为 1，不敏感）
    } finally {
      vi.useRealTimers()
    }

    await fixture.server.close()
  })
})
