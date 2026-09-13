/**
 * MCPClient · 分派与默认装配（#11）+ defaultProcessController 转发目标（#12甲）（批 2 · Task 12）
 *
 * 环境闸门（Step 1，本文件最先跑通的结论）：
 *   ✅ SDK 的 ESM 子模块可被 `vi.mock` 成功替换。写法一律用 `@` 别名（vitest.config.ts 配 `'@' → src`）：
 *      `vi.mock('@/main/agent/mcp/transport/stdio', ...)`、`vi.mock('@/main/agent/mcp/transport/processUtils', ...)`，
 *      SDK 子模块用真实包路径 `vi.mock('@modelcontextprotocol/sdk/client/sse.js', ...)`（SDK package.json
 *      `exports["./*"] → ./dist/esm/*` 通配命中）。
 *   踩坑记录：
 *      - 相对路径 `'./transport/stdio'` 会被相对**测试文件**解析 → module-not-found，必须用 `@` 别名。
 *      - mock 工厂**必须同时提供** `createStdioTransport` 与 `killProcessTree`（client.ts:26 一条 import 同时取两者；
 *        只给前者 → `killProcessTree` 变 undefined，stopServer/killServerProcess 路径踩空）。
 *      - **不可** `vi.spyOn(mod, 'createTransport')` 断言"内部调用了自身导出"——ESM 模块内部对自身导出函数的调用
 *        不经过模块命名空间对象，spy 计数恒 0。故此处直接 `import { createTransport }` 后直接调用它断言其**分派结果**。
 *
 * 行号以当前 HEAD 实测为准（步 1 装接缝后 client.ts 已漂移到 650 行）：
 *   `defaultProcessController` :51-55（isRunning :52 / waitForExit :53 / killTree :54）
 *   构造器默认装配 :124-125（`?? createTransport` :124 / `?? defaultProcessController` :125）
 *   `transportFactory` 调用点 :271 · `createTransport`（module-level）:626-647 · 分派 switch :628-646
 *   `defaultProcessController.waitForExit` 把 timeoutMs 原样透传（含 undefined）→ 5000 缺省由 processUtils.ts:32 提供
 *
 * 步 2 总纪律：本批没有 TDD 意义上的 red-green（接缝是测试前提），每条用例写完必须**故意改坏 `src/` 实现**
 *   确认用例变红，再改回。**禁止**放宽断言或用改坏测试制造红。
 *
 * 变异验证记录（批 2）
 * #11 分派（变异 A）  变异：`case 'websocket'` 分支改指向 `new StreamableHTTPClientTransport(...)`（调换分支目标）
 *     → 期望红 ✅实测红
 *     （AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 *       ❯ client.transportDispatch.test.ts:139  ← websocket 断言 wsCtor 计数）
 *     → 已改回，`git diff -- src/` 为空
 * #11 分派（变异 B，补证 http/streamable-http 共用断言敏感）  变异：拆开共用 case，令 `streamable-http` 改走
 *       `new WebSocketClientTransport(...)`（只让 http 走 httpCtor）
 *     → 期望红 ✅实测红
 *     （AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times
 *       ❯ client.transportDispatch.test.ts:131  ← http/streamable 共用断言）
 *     → 已改回，`git diff -- src/` 为空
 * #11 默认装配  变异：构造器 :124 `options?.transportFactory ?? createTransport` 改为
 *       `options?.transportFactory ?? (() => { throw new Error('no factory') })`（默认分支不再落到 createTransport）
 *     → 期望红 ✅实测红（两条断言**均敏感**，逐条取证）：
 *        ① AssertionError: expected [Function] to throw error including 'nope' but got 'no factory'
 *        ② 暂缓 ① 后（临时放宽为 `.rejects.toThrow()`，取证后已还原）：
 *           AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 *           ❯ client.transportDispatch.test.ts:176  ← createStdioTransport 未被调
 *     → 已改回，`git diff -- src/` 为空
 * #12甲 killTree  变异：`killTree: (pid) => killProcessTree(pid)` 改为 `killProcessTree(pid + 1)`
 *     → 期望红 ✅实测红
 *     （AssertionError: expected "vi.fn()" to be called with arguments: [ 123 ]
 *       Received: - 123, + 124,   Number of calls: 1）
 *     → 已改回，`git diff -- src/` 为空
 * #12甲 waitForExit 透传  变异：`waitForExit: (pid, timeoutMs) => waitForProcessExit(pid, timeoutMs)`
 *       改为 `waitForProcessExit(pid, timeoutMs ?? 5000)`（在接缝处重复声明缺省值）
 *     → 期望红 ✅实测红
 *     （AssertionError: expected "vi.fn()" to be called with arguments: [ 123, undefined ]
 *       Received: - undefined, + 5000,   Number of calls: 1）
 *     → 已改回，`git diff -- src/` 为空
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MCPServerConfig } from '@/main/agent/mcp/types'

// ─── hoisted mock 句柄（vi.mock 工厂被提升，无法引用普通顶层变量） ───────────────
const {
  createStdioTransportMock,
  killProcessTreeMock,
  isProcessRunningMock,
  waitForProcessExitMock,
  sseCtor,
  httpCtor,
  wsCtor,
  stdioCtor,
} = vi.hoisted(() => ({
  createStdioTransportMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
  isProcessRunningMock: vi.fn(() => false),
  waitForProcessExitMock: vi.fn(async () => true),
  sseCtor: vi.fn(),
  httpCtor: vi.fn(),
  wsCtor: vi.fn(),
  stdioCtor: vi.fn(),
}))

// ⚠️ 必须同时提供 createStdioTransport 与 killProcessTree（client.ts:26 同一条 import 取两者）
vi.mock('@/main/agent/mcp/transport/stdio', () => ({
  createStdioTransport: createStdioTransportMock,
  killProcessTree: killProcessTreeMock,
}))
vi.mock('@/main/agent/mcp/transport/processUtils', () => ({
  isProcessRunning: isProcessRunningMock,
  waitForProcessExit: waitForProcessExitMock,
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: sseCtor }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: httpCtor }))
vi.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({ WebSocketClientTransport: wsCtor }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: stdioCtor }))

import { createTransport, defaultProcessController, MCPClient } from '@/main/agent/mcp/client'
import type { ClientTransport } from '@/main/agent/mcp/client'

function cfg(over: Partial<MCPServerConfig> & Pick<MCPServerConfig, 'id' | 'name' | 'transport'>): MCPServerConfig {
  return { enabled: true, ...over }
}

describe('createTransport 分派（批 2 · #11）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stdio → createStdioTransport，且选项映射为 {command,args,env,cwd,stderr:"pipe"}', () => {
    createTransport(
      cfg({
        id: 'a',
        name: 'a',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        env: { A: '1' },
        cwd: '/tmp',
      }),
    )
    expect(createStdioTransportMock).toHaveBeenCalledTimes(1)
    expect(createStdioTransportMock).toHaveBeenCalledWith({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      cwd: '/tmp',
      stderr: 'pipe',
    })
  })

  it('sse → new SSEClientTransport(url, {requestInit:{headers}})', () => {
    createTransport(cfg({ id: 'b', name: 'b', transport: 'sse', url: 'http://x/sse', headers: { H: '1' } }))
    expect(sseCtor).toHaveBeenCalledTimes(1)
    expect(String(sseCtor.mock.calls[0][0])).toBe('http://x/sse')
    expect(sseCtor.mock.calls[0][1]).toEqual({ requestInit: { headers: { H: '1' } } })
  })

  it('http 与 streamable-http 共用同一构造器（StreamableHTTPClientTransport）', () => {
    createTransport(cfg({ id: 'c', name: 'c', transport: 'http', url: 'http://x/mcp' }))
    createTransport(cfg({ id: 'd', name: 'd', transport: 'streamable-http', url: 'http://x/mcp' }))
    expect(httpCtor).toHaveBeenCalledTimes(2)
    // 均无 headers → requestInit 为 undefined
    expect(httpCtor.mock.calls[0][1]).toEqual({ requestInit: undefined })
    expect(httpCtor.mock.calls[1][1]).toEqual({ requestInit: undefined })
  })

  it('websocket → new WebSocketClientTransport(url)', () => {
    createTransport(cfg({ id: 'e', name: 'e', transport: 'websocket', url: 'ws://x' }))
    expect(wsCtor).toHaveBeenCalledTimes(1)
    // new URL('ws://x') 归一化为 'ws://x/'（URL 规范补默认路径 /）
    expect(String(wsCtor.mock.calls[0][0])).toBe('ws://x/')
  })

  it('未知 transport → 抛 "不支持的传输方式"', () => {
    expect(() => createTransport(cfg({ id: 'f', name: 'f', transport: 'bogus' as MCPServerConfig['transport'] }))).toThrow(
      '不支持的传输方式',
    )
  })
})

describe('createTransport 默认装配（批 2 · #11）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('不注入 transportFactory 建 client → connect 经默认分支走到被 mock 的 createStdioTransport', async () => {
    // 假 transport：start() 立即 reject，逼 connect 走失败路径（maxRetries=0 → 仅一次尝试，无退避等待）
    const fakeTransport = {
      start: async () => {
        throw new Error('nope')
      },
      close: async () => {},
      send: async () => {},
    } as unknown as ClientTransport
    createStdioTransportMock.mockReturnValue(fakeTransport)

    const client = new MCPClient() // 不注入 transportFactory → 构造器缺省装配 createTransport（client.ts:124）
    const r11 = await client.connect(
      cfg({ id: 'z', name: 'z', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }),
      0, // ⚠️ maxRetries=0：默认 5 会退避合计 31s > testTimeout 10000
    )
    expect(r11).toEqual({ success: false, error: 'nope' }) // 出口 3：不再抛出

    // 默认分支确实落到被 mock 的 createStdioTransport，且入参映射与直接调用 createTransport 一致
    expect(createStdioTransportMock).toHaveBeenCalledTimes(1)
    expect(createStdioTransportMock).toHaveBeenCalledWith({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: undefined,
      cwd: undefined,
      stderr: 'pipe',
    })
  })
})

describe('defaultProcessController 转发目标（批 2 · #12甲）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('isRunning / waitForExit / killTree 分别转发到 processUtils 与 transport/stdio 的被 mock 函数', async () => {
    // isRunning 转发目标 = 被 mock 的 isProcessRunning（默认返回 false）
    expect(defaultProcessController.isRunning(123)).toBe(false)
    expect(isProcessRunningMock).toHaveBeenCalledWith(123)
    expect(isProcessRunningMock).toHaveBeenCalledTimes(1)

    // waitForExit：单参调用 → timeoutMs 透传 undefined（缺省 5000 由 processUtils.ts:32 提供，接缝处不得重复声明）
    expect(await defaultProcessController.waitForExit(123)).toBe(true)
    expect(waitForProcessExitMock).toHaveBeenCalledWith(123, undefined)
    expect(waitForProcessExitMock).toHaveBeenCalledTimes(1)

    // killTree 转发目标 = 被 mock 的 killProcessTree
    defaultProcessController.killTree(123)
    expect(killProcessTreeMock).toHaveBeenCalledWith(123)
    expect(killProcessTreeMock).toHaveBeenCalledTimes(1)
  })
})
