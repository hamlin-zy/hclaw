/**
 * MCPClient · 真实 stdio 进程控制（#9 + #12乙）（批 2 · Task 11）
 *
 * 为什么必须真实 stdio（spec v2.2 修正）：
 *   `lastPid` 仅在 `state.sdkTransport instanceof StdioClientTransport`（`client.ts:284`）
 *   且握手成功时写入（`:286`）；失败路径 `killServerProcess`（`:367-372`）会把它清空
 *   → 只覆写 `pid` getter 的假 transport **不可达**，必须拉起真实子进程。
 *
 * 本文件**不 mock** `transport/stdio`、**不 mock** SDK `stdio` 子模块：
 *   transportFactory 直接返回真实 `createStdioTransport(...)`，子进程为
 *   `node tests/fixtures/minimalMcpServer.mjs`（低层 Server + StdioServerTransport，注册 echo 工具）。
 *
 * fixture 路径解析（实测）：`__dirname` = `tests/main/agent/mcp`，上溯 **3 层** 得 `tests/`，
 *   即 `path.resolve(__dirname, '../../../fixtures/minimalMcpServer.mjs')`。
 *   ⚠️ 计划写的是 4 层（`'../../../../'`）→ 会指到 `<repo>/fixtures/...`（不存在），实测已纠正。
 *
 * ⚠️ 孤儿进程纪律：`afterEach` 先经 `getAllServers()+stopServer()` 断开全部（批 3 P4 起
 *   `disconnectAll` 已删），再对记录到的、仍存活的 pid 调**真**
 *   `killProcessTree`（双保险）。#12乙 对模块级单例 `defaultProcessController` 上了 `vi.spyOn`，
 *   必须在 `afterEach` `vi.restoreAllMocks()`，否则跨文件泄漏。
 *
 * 步 2 总纪律：本批没有 TDD 意义上的 red-green（接缝是测试前提），
 *   每条用例写完必须**故意改坏 `src/` 实现**确认用例变红，再改回。**禁止**放宽断言或用改坏测试制造红。
 *
 * 行号以当前 HEAD 实测为准（步 1 装接缝后 `client.ts` 已漂移到 650 行，比计划 §8 F1 的 609 更远）：
 *   PID 闭环整块 :203-211（`oldPid` :204 / `isRunning` :205 / `killTree` :208 / `waitForExit` :210）
 *   `transportFactory` 调用点 :271 · `instanceof StdioClientTransport` :284 · `lastPid` 写入 :286
 *   `killServerProcess` :367-372（`if (!state.lastPid) return` :368 / `killTree` :369 / `waitForExit` :370）
 *   `stopServer` :103-135 · 构造器默认装配 :124-125 · `defaultProcessController` :51-55
 *
 * 变异验证记录（批 2）
 * #9  变异：删 `client.ts:203-211` 的 PID 闭环整块（`oldState`/`oldPid`/`if (oldPid && isRunning...)`）
 *     → 期望红 ✅实测红
 *     （AssertionError: expected "vi.fn()" to be called with arguments: [ 34428 ]
 *       Number of calls: 0   ← 打红 ① `expect(isRunningFn).toHaveBeenCalledWith(pid)`）
 *     ⚠️ 实测敏感度分析（逐条取证，非放宽断言）：② `injectedPids).toContain(pid)` 与
 *        ③ `firstKill < secondFactory` **单独看不敏感** —— 删闭环后 `disconnect()→killServerProcess()`
 *        仍会 `killTree(oldPid)`，故 ②③ 依然成立（实测：暂缓 ① 后 #9 仍绿）。
 *        真正的判别力来自 ① 与新增的相邻性断言 ③' `firstKill === isRunningIdx + 1`
 *        （实测：暂缓 ① 后 ③' 变红 → `AssertionError: expected 1 to be +0`）。
 *        取证用的临时「暂缓 ①」已还原。
 *     → 已改回，`git diff -- src/` 为空
 * #12乙 变异：构造器默认装配 `client.ts:125` `options?.processController ?? defaultProcessController`
 *        改为 `?? { isRunning: () => false, waitForExit: async () => true, killTree: () => {} }`
 *     → 期望红 ✅实测红（两条断言**均敏感**，逐条取证）：
 *        ① AssertionError: expected "killTree" to be called with arguments: [ 29388 ] / Number of calls: 0
 *        ② AssertionError: expected "waitForExit" to be called with arguments: [ 17600 ] / Number of calls: 0
 *        （暂缓 ① 以暴露 ②，取证后已还原）
 *     → 已改回，`git diff -- src/` 为空
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import { MCPClient, defaultProcessController } from '@/main/agent/mcp/client'
import type { ProcessController } from '@/main/agent/mcp/client'
import type { MCPServerConfig } from '@/main/agent/mcp/types'
import { createStdioTransport, killProcessTree } from '@/main/agent/mcp/transport/stdio'
import { isProcessRunning } from '@/main/agent/mcp/transport/processUtils'

/** fixture 绝对路径（上溯 3 层，见文件头「fixture 路径解析」） */
const FIXTURE = path.resolve(__dirname, '../../../fixtures/minimalMcpServer.mjs')

const SERVER_ID = 'srv-pid'

const CFG: MCPServerConfig = {
  id: SERVER_ID,
  name: 'pid-fixture',
  transport: 'stdio',
  enabled: true,
  command: process.execPath,
  args: [FIXTURE],
}

let client: MCPClient | undefined
/** 本用例触及过的 pid（含 fake controller 注入的旧 pid），afterEach 收尾真杀 */
const trackedPids: number[] = []

function trackPid(pid: number | undefined): void {
  if (typeof pid === 'number' && !trackedPids.includes(pid)) trackedPids.push(pid)
}

afterEach(async () => {
  // 1) 尽力断开（残留的 sdk client / transport 由 stopServer 清理）
  if (client) {
    const c = client
    trackPid(c.getServerPid(SERVER_ID))
    await Promise.all(c.getAllServers().map((s) => c.stopServer(s.config.id))).catch(() => { /* 故意吞：清理失败不阻塞 afterEach */ })
  }
  // 2) 双保险：对仍存活的 pid 真杀（taskkill /F /T，进程已退出时为 no-op）
  for (const pid of trackedPids) {
    if (isProcessRunning(pid)) killProcessTree(pid)
  }
  trackedPids.length = 0
  client = undefined
  // 3) #12乙 对模块级单例 defaultProcessController 上了 spy —— 必须还原
  vi.restoreAllMocks()
})

describe('MCPClient · 真实 stdio 进程控制（批 2 · Task 11）', () => {
  it('#9 connect 时旧 state 带存活 PID → 先 killTree(oldPid) 再建新 transport', async () => {
    const order: string[] = []
    const injectedPids: number[] = []

    // 恒真：制造「旧进程仍存活」，逼出 PID 闭环分支
    const isRunningFn = vi.fn((pid: number) => {
      order.push(`isRunning:${pid}`)
      return true
    })
    const waitForExitFn = vi.fn(async (_pid: number, _timeoutMs?: number) => true)
    const killTreeFn = vi.fn((pid: number) => {
      order.push(`killTree:${pid}`)
      injectedPids.push(pid)
      killProcessTree(pid) // 真杀，避免孤儿
    })

    const fakeController: ProcessController = {
      isRunning: isRunningFn,
      waitForExit: waitForExitFn,
      killTree: killTreeFn,
    }

    client = new MCPClient({
      transportFactory: () => {
        order.push('factory')
        return createStdioTransport({ command: process.execPath, args: [FIXTURE] })
      },
      processController: fakeController,
    })

    // 第一次 connect：无旧 state → 真实握手成功，写入真实 PID
    await client.connect(CFG)
    const pidFromClient = client.getServerPid(SERVER_ID)
    trackPid(pidFromClient)
    expect(Number.isInteger(pidFromClient)).toBe(true)
    expect(client.getServer(SERVER_ID)?.status).toBe('connected')
    const pid = pidFromClient as number

    // 第二次 connect：oldState.lastPid 命中且 isRunning(oldPid) === true → 走 PID 闭环
    await client.connect(CFG)
    trackPid(client.getServerPid(SERVER_ID))

    // ① 旧 PID 被探测为存活
    expect(isRunningFn).toHaveBeenCalledWith(pid)
    // ② 旧 PID 被交给 killTree
    expect(injectedPids).toContain(pid)
    // ③ 调用序（敏感断言）：isRunning(oldPid) **紧接** killTree(oldPid)，且早于第二次 transport 创建
    //    注意：②③ 单独看**不敏感**——即便删掉 PID 闭环，`disconnect()→killServerProcess()` 仍会杀旧 PID，
    //    故 `injectedPids` 与「killTree 早于 2nd factory」都依然成立。真正的判别力来自 ① 与下面这条
    //    「isRunning 紧接 killTree」的相邻性断言（实测：删闭环后 order 里 isRunning 缺席 → 期望红）。
    const firstFactory = order.indexOf('factory')
    const secondFactory = order.indexOf('factory', firstFactory + 1)
    const isRunningIdx = order.indexOf(`isRunning:${pid}`)
    const firstKill = order.indexOf(`killTree:${pid}`)
    expect(firstFactory).toBeGreaterThan(-1)
    expect(secondFactory).toBeGreaterThan(-1)
    expect(firstKill).toBeGreaterThan(-1)
    expect(firstKill).toBe(isRunningIdx + 1)
    expect(firstKill).toBeLessThan(secondFactory)
  })

  it('#12乙 未注入 processController → stopServer 经 defaultProcessController 转发 killTree/waitForExit', async () => {
    // spy 到模块级单例上，但保留真实的杀进程行为（否则制造孤儿）
    const killSpy = vi
      .spyOn(defaultProcessController, 'killTree')
      .mockImplementation((pid: number) => killProcessTree(pid))
    const waitSpy = vi
      .spyOn(defaultProcessController, 'waitForExit')
      .mockImplementation(async () => true)

    // 不传 processController → 构造器缺省装配 defaultProcessController（client.ts:125）
    client = new MCPClient({
      transportFactory: () => createStdioTransport({ command: process.execPath, args: [FIXTURE] }),
    })

    await client.connect(CFG)
    const pid = client.getServerPid(SERVER_ID)
    trackPid(pid)
    expect(Number.isInteger(pid)).toBe(true)
    const realPid = pid as number

    await client.stopServer(SERVER_ID)

    // killServerProcess（client.ts:369-370）经 defaultProcessController 转发
    expect(killSpy).toHaveBeenCalledWith(realPid)
    expect(waitSpy).toHaveBeenCalledWith(realPid)
  })
})
