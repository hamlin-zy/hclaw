/**
 * MCPClient · 退避重连（组 B：#6a / #6b / #7 / #8）（批 2 · Task 10）
 *
 * 观测手段（spec v2.7 方案 1，本文件全组共用）：
 *   `sleep` 是私有**实例方法**（`client.ts:375`，内部 `setTimeout`）。
 *   用 `vi.spyOn(client as any, 'sleep').mockImplementation(() => Promise.resolve())`
 *   —— 实例 spy 影子化原型方法，能拦 `client.ts:262` 的 `this.sleep(delay)`。
 *   **不引入假时钟、无死锁**：`await client.connect(...)` 后直接断 `sleepSpy.mock.calls` 的实参序列。
 *   ⚠️ #8 例外：必须用**可手动 resolve 的 deferred** sleep spy（见该用例注释）。
 *
 * 本文件**无假时钟**（未使用 `vi.useFakeTimers`）。
 * 本文件**不 mock SDK client 子模块**：失败 transport 用「工厂直接 throw」（`client.ts:270` 的 try 内，
 * 抛错进入同一 catch 分支）；成功 transport 用 `createInMemoryMcpServer()` 的真实 `clientTransport`。
 *
 * 行号以当前 HEAD 实测为准（批 1 删 `loadPluginServers` + 步 1 装接缝后，漂移大于计划 §8 F1）：
 *   `Math.pow(2, attempt - 1)` :259 · `this.sleep(delay)` :262 · post-sleep 守卫 :263-267
 *   循环头守卫 :250-254 · `MAX_DELAY_MS` :232 · `lastErrorTime` 写入 :360 · `sleep` 定义 :375
 *
 * 步 2 总纪律：本批没有 TDD 意义上的 red-green（接缝是测试前提），
 * 故每条用例写完必须**故意改坏 `src/` 实现**确认用例变红，再改回。
 *
 * 变异验证记录（批 2）
 * #6a 变异：`client.ts:259` `Math.pow(2, attempt - 1)` → `Math.pow(2, attempt)` → 期望首段变 2000 → ✅实测红
 *      （AssertionError: expected [ 2000, 4000, 8000 ] to deeply equal [ 1000, 2000, 4000 ]）
 *      共用同一公式 → #6b/#7 的 delay 序列断言连带红（实测 #7 = `expected [ 2000, 4000 ] to deeply equal [ 1000, 2000 ]`）
 *      → 已改回，`git diff` 为空
 * #6b 变异：`client.ts:232` `MAX_DELAY_MS = 30000` → `60000` → 期望第 6 段变 32000 → ✅实测红
 *      （AssertionError: expected [ Array(6) ] to deeply equal [ Array(6) ]，diff `- 30000, + 32000`）
 *      仅 #6b 红（#6a/#7 不受影响）→ 已改回，`git diff` 为空
 * #7  变异：删 `client.ts:360` `state.lastErrorTime = Date.now()` → 期望 undefined → ✅实测红
 *      （AssertionError: expected undefined to be type of 'number'）→ 已改回，`git diff` 为空
 * #8  变异：注释掉 `client.ts:263-267` 的 **post-sleep 守卫**（非 :250-254 的循环头守卫）→ ✅实测红
 *      实测该变异同时打红以下断言（计划只预言「两处」）：
 *        ① AssertionError: expected 'rejected' to be 'resolved' // Object.is equality
 *        ② AssertionError: expected 2 to be 1 // Object.is equality          （factoryCount）
 *        ③ AssertionError: expected 'error' to be 'stopped' // Object.is equality
 *        ④ AssertionError: expected [ 'error', 'error' ] to not include 'error'
 *        ⑤ AssertionError: expected [ 'error', 'error' ] to deeply equal []  （afterStop）
 *      ⚠️ ①-⑤ 为逐条取证，运行时临时上移/停用别的断言以暴露下一条（非放宽断言，取证后已还原）；
 *         原 `not.toContain('connecting')` 恒真（重试轮只 emit `'reconnecting'`，永不 emit 第二轮 `'connecting'`，
 *         `afterStop` 恒为空数组 → 零区分度）→ 终评 Important 修复项改为 `expect(afterStop).toEqual([])` 后，⑤ 方可被本变异打红。
 *         → 已改回，`git diff` 为空
 *
 * 变异验证记录（批 4 · P6）
 * M1 出口 1 `return { success: true }` → `return { success: false }` → ✅实测红：#14
 *      （AssertionError: expected { success: false } to deeply equal { success: true }）；#20 成功分支连带红
 * M2 出口 3 `return { success:false, error: lastError?.message ?? 'Connection failed' }`
 *      → `throw lastError || new Error('MCP server connection failed')` → ✅实测红：#15
 *      （AssertionError: promise rejected "Error: boom" instead of resolving）；#6b/#7/#20 连带红
 * M3 post-sleep 取消出口 `return { success:false, error:'Cancelled by external stop' }` → `return { success: true }`
 *      → ✅实测红：#16（AssertionError: expected { success: true } to deeply equal { success:false, error:'Cancelled by external stop' }）
 * M4 `return this.connect(config, maxRetries)` → `this.connect(config, maxRetries)` → ✅实测红：#20
 *      （AssertionError: expected undefined to deeply equal { success: true }）
 *      → 四条均改回，`git diff -- src/main/agent/mcp/client.ts` 仅剩本轮真实改动（无残留变异）
 *      ⚠️ 批 2 的 #8 记录 ①「expected 'rejected' to be 'resolved'」随 P6 消失：出口 3 不再 throw，删 post-sleep 守卫时该用例仍 resolve。
 *          #8 的 `expect(outcome).toBe('resolved')` 在 P6 下依旧成立（被 stop 时 connect resolve {success:false,error:'Cancelled by external stop'}），保持不变。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MCPClient } from '@/main/agent/mcp/client'
import type { ClientTransport } from '@/main/agent/mcp/client'
import type { MCPServerConfig } from '@/main/agent/mcp/types'
import { createInMemoryMcpServer } from './helpers/inMemoryMcpServer'

/** 退避 spy 的最小可调用面（`sleep` 是私有实例方法，无法直接取类型） */
type SleepHost = { sleep: (ms: number) => Promise<void> }
/** vi.spyOn 返回的 spy（只取我们断言的 mock.calls） */
type SleepSpy = { mock: { calls: [number][] } }

const cfg: MCPServerConfig = { id: 'srv-1', name: 'fixture', transport: 'stdio', enabled: true }

/** 每次调用都失败：工厂直接 throw（`client.ts:270` 在 try 内 → 进入同一 catch 分支） */
const alwaysFailing = (): never => {
  throw new Error('boom')
}

/** 取 sleepSpy 的 delay 实参序列（tsconfig lib=ES2020 → `Array.prototype.at` 不在类型面内） */
function delaysOf(spy: SleepSpy): number[] {
  return spy.mock.calls.map((c) => c[0])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MCPClient · 退避重连（组 B）', () => {
  it('#6a 前 3 次失败第 4 次成功 → 退避序列 [1000,2000,4000] + 中途 reconnecting', async () => {
    const fixture = createInMemoryMcpServer({ name: 'fixture-srv' })
    await fixture.server.connect(fixture.serverTransport)

    let call = 0
    const client = new MCPClient({
      transportFactory: () => {
        call++
        if (call <= 3) throw new Error('boom')
        return fixture.clientTransport as unknown as ClientTransport
      },
    })
    const sleepSpy = vi
      .spyOn(client as unknown as SleepHost, 'sleep')
      .mockImplementation(() => Promise.resolve())

    const emitted: string[] = []
    client.onStatusChange('srv-1', (s) => emitted.push(s.status))

    await client.connect(cfg) // 默认 maxRetries=5

    // 精确断言：2^(attempt-1) 在 attempt 1/2/3 → [1000,2000,4000]
    expect(delaysOf(sleepSpy)).toEqual([1000, 2000, 4000])
    expect(emitted).toContain('reconnecting')
    expect(client.getServer('srv-1')!.status).toBe('connected')
    expect(call).toBe(4)
  })

  it('#6b 显式 connect(cfg, 6) → 6 段间隔，第 6 段封顶 30000', async () => {
    const client = new MCPClient({ transportFactory: alwaysFailing })
    const sleepSpy = vi
      .spyOn(client as unknown as SleepHost, 'sleep')
      .mockImplementation(() => Promise.resolve())

    const r6b = await client.connect(cfg, 6)
    expect(r6b).toEqual({ success: false, error: 'boom' }) // 全失败：出口 3 返回结果对象

    const delays = delaysOf(sleepSpy)
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
    expect(delays[4]).toBe(16000) // 上界区分（默认 maxRetries=5 时最大间隔，永远碰不到封顶）
    expect(delays[5]).toBe(30000) // 封顶
  })

  it('#7 打满 maxRetries → status=error + lastErrorTime 写入 + 返回 {success:false}', async () => {
    const client = new MCPClient({ transportFactory: alwaysFailing })
    const sleepSpy = vi
      .spyOn(client as unknown as SleepHost, 'sleep')
      .mockImplementation(() => Promise.resolve())

    const r7 = await client.connect(cfg, 2)
    expect(r7.success).toBe(false)
    expect(r7.error).toBe('boom')

    const snap = client.getServer('srv-1')!
    expect(snap.status).toBe('error')
    expect(snap.lastErrorTime).toBeTypeOf('number')
    expect(delaysOf(sleepSpy)).toEqual([1000, 2000])
  })

  it('#8 退避 sleep 期间 stopServer → 重试中止（不再建 transport / 不再发 error）', async () => {
    // ⚠️ 必须用**可手动 resolve 的 deferred** sleep：若用 #6a 的「立即 resolve」版，
    //    stopServer 只能落到下一轮循环头守卫（:250-254），post-sleep 守卫（:263-267）不改变可观测结果。
    let release!: () => void
    let factoryCount = 0
    const client = new MCPClient({
      transportFactory: () => {
        factoryCount++
        throw new Error('boom')
      },
    })
    const sleepSpy: SleepSpy = vi
      .spyOn(client as unknown as SleepHost, 'sleep')
      .mockImplementation(() => new Promise<void>((r) => { release = r }))

    const emitted: string[] = []
    client.onStatusChange('srv-1', (s) => emitted.push(s.status))

    // maxRetries=1：中止后恰好只剩「不建 transport、不发 error」的可观测差异，
    // 且变异（删 post-sleep 守卫）时循环自然结束 → P6 出口 3 返回 {success:false}（不再 throw），p 仍 resolve、不挂起
    //（默认 5 会二次挂起 → 只能超时红）
    const p = client.connect(cfg, 1) // 不要 await
    await vi.waitFor(() => expect(sleepSpy).toHaveBeenCalledTimes(1)) // 确认进入退避
    await client.stopServer('srv-1')
    release()

    let outcome: 'resolved' | 'rejected' = 'resolved'
    await p.then(
      () => { outcome = 'resolved' },
      () => { outcome = 'rejected' },
    )

    expect(outcome).toBe('resolved') // 批 2 断言 resolve；批 4 改判 {success:false, error:'Cancelled by external stop'}
    expect(factoryCount).toBe(1) // transportFactory 仅被调用 1 次
    expect(client.getServer('srv-1')!.status).toBe('stopped')
    const afterStop = emitted.slice(emitted.lastIndexOf('stopped') + 1)
    // 停后不应再有任何 emit（末次 'stopped' 即 post-sleep 守卫的 emit，其后 doConnect 立即 return）
    expect(afterStop).toEqual([])
    expect(afterStop).not.toContain('error') // 不再发射 error（守卫的 emit 状态是 'stopped'）
  })
})

describe('MCPClient · P6 错误语义（批 4 · #14/#15/#16/#20）', () => {
  it('#14 connect 成功 → {success:true}，onStatusChange 序列不变', async () => {
    const fixture = createInMemoryMcpServer({ name: 'fixture-srv' })
    await fixture.server.connect(fixture.serverTransport)

    const client = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    const emitted: string[] = []
    client.onStatusChange('srv-1', (s) => emitted.push(s.status))

    const r = await client.connect(cfg)

    expect(r).toEqual({ success: true })
    // connect() 立即 emit 'connecting'(:228) → transport 起来后 emit(:289，仍 connecting) → 工具发现后 emit 'connected'(:326)
    expect(emitted).toEqual(['connecting', 'connecting', 'connected'])
    expect(client.getServer('srv-1')!.status).toBe('connected')
  })

  it('#15 重试耗尽（maxRetries=0）→ resolves {success:false,error}，status=error 且 lastErrorTime 写入', async () => {
    const client = new MCPClient({ transportFactory: alwaysFailing })

    // 关键：断言 resolves（不再 throw）
    await expect(client.connect(cfg, 0)).resolves.toEqual({ success: false, error: 'boom' })

    const snap = client.getServer('srv-1')!
    expect(snap.status).toBe('error')
    expect(snap.lastErrorTime).toBeTypeOf('number')
  })

  it('#16 退避中被 stopServer → {success:false, error:"Cancelled by external stop"} 且 status=stopped', async () => {
    let release!: () => void
    let factoryCount = 0
    const client = new MCPClient({
      transportFactory: () => {
        factoryCount++
        throw new Error('boom')
      },
    })
    const sleepSpy = vi.spyOn(client as unknown as SleepHost, 'sleep').mockImplementation(
      () => new Promise<void>((r) => { release = r }),
    )

    const p = client.connect(cfg, 1) // 不要 await
    // ⚠️ 必须等 `sleep` 真正 pending（`release` 就绪），而非仅 `factoryCount===1`：
    //    后者只证明第 1 次尝试已失败，stopServer 可能抢在 doConnect 续体之前置 stopped，
    //    使中止落到循环头守卫（出口 2 之一）→ release 未就绪、用例不确定。
    //    等 sleepSpy 被调用（仅 stopServer 能中止，故必到）可确定命中 post-sleep 守卫（出口 2 之二）。
    await vi.waitFor(() => expect(sleepSpy).toHaveBeenCalledTimes(1))
    expect(factoryCount).toBe(1) // 已进入退避，且 transportFactory 仅被调用 1 次
    await client.stopServer('srv-1')
    release()

    expect(await p).toEqual({ success: false, error: 'Cancelled by external stop' })
    expect(client.getServer('srv-1')!.status).toBe('stopped') // 出口 2：stopped，不是 error
  })

  it('#20 startServer 透传 connect 结果（成功 {success:true} / 失败 {success:false,error}）', async () => {
    const fixture = createInMemoryMcpServer({ name: 'fixture-srv' })
    await fixture.server.connect(fixture.serverTransport)
    const okClient = new MCPClient({
      transportFactory: () => fixture.clientTransport as unknown as ClientTransport,
    })
    expect(await okClient.startServer(cfg)).toEqual({ success: true })

    const badClient = new MCPClient({ transportFactory: alwaysFailing })
    expect(await badClient.startServer(cfg, 0)).toEqual({ success: false, error: 'boom' })
  })
})
