import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import type {LlmUsageRecord} from '@shared/types'

/**
 * recordLlmUsageEvent（路径 1：主循环写入）
 *
 * 回归背景：一条 assistant 消息对应多轮 LLM 调用（工具循环）时，每轮 llm_call_done
 * 都写同一 messageId。修复前 seq 恒为 0 → 幂等键 usage_<messageId>_0 撞车，
 * INSERT OR IGNORE 只保留第 1 轮，后续 85 轮统计静默丢失（重启后 UI 只显示第 1 轮）。
 * 修复：按 messageId 维护递增 seq（与子会话路径 agentTool.ts 的 seq 语义一致）。
 */
describe('recordLlmUsageEvent（路径 1 主循环写入）', () => {
  /** vi.resetModules 后重新加载模块，拿到干净的模块级 seq 状态 */
  async function freshRecord() {
    const {recordLlmUsageEvent} = await import('@/main/usageWrite')
    return recordLlmUsageEvent
  }

  beforeEach(() => {
    // 清空模块级 seq 状态，避免用例间串扰
    vi.resetModules()
  })

  it('从事件取 messageId（主进程注入的 pending.id）+ seq=0 + conversationId', async () => {
    const recordLlmUsageEvent = await freshRecord()
    const repo = {record: vi.fn()}
    recordLlmUsageEvent('conv-1', {
      type: 'llm_call_done',
      conversationTitle: 't',
      provider: '方案A',
      providerType: 'anthropic',
      providerName: 'Deepseek-ant',
      model: 'claude-sonnet-4',
      duration: 1234,
      inputTokens: 100,
      outputTokens: 20,
      messageId: 'm-1',
    } as never, repo)

    expect(repo.record).toHaveBeenCalledTimes(1)
    const rec = (repo.record as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LlmUsageRecord
    expect(rec.id).toBe('usage_m-1_0')
    expect(rec.conversationId).toBe('conv-1')
    expect(rec.messageId).toBe('m-1')
    expect(rec.providerType).toBe('anthropic')
    expect(rec.providerName).toBe('Deepseek-ant')
  })

  it('同一 messageId 多轮调用 → seq 递增（0,1,2…），幂等键不撞车', async () => {
    const recordLlmUsageEvent = await freshRecord()
    const repo = {record: vi.fn()}
    const base = {
      type: 'llm_call_done',
      providerType: 'anthropic',
      model: 'deepseek-v4-flash',
      duration: 100,
    } as const
    for (let i = 0; i < 3; i++) {
      recordLlmUsageEvent('conv-1', {
        ...base,
        inputTokens: 1000 + i,
        outputTokens: 10 + i,
        cacheReadTokens: 9000 + i * 1000,
        messageId: 'm-1',
      } as never, repo)
    }

    expect(repo.record).toHaveBeenCalledTimes(3)
    const recs = (repo.record as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as LlmUsageRecord)
    expect(recs.map(r => r.id)).toEqual(['usage_m-1_0', 'usage_m-1_1', 'usage_m-1_2'])
    expect(recs.map(r => r.inputTokens)).toEqual([1000, 1001, 1002])
  })

  it('不同 messageId（多轮之间的 pending 重建）各自从 0 开始', async () => {
    const recordLlmUsageEvent = await freshRecord()
    const repo = {record: vi.fn()}
    const base = {type: 'llm_call_done', providerType: 'openai', model: 'gpt-4o', duration: 1} as const
    recordLlmUsageEvent('conv-1', {...base, inputTokens: 1, outputTokens: 1, messageId: 'm-a'} as never, repo)
    recordLlmUsageEvent('conv-1', {...base, inputTokens: 2, outputTokens: 2, messageId: 'm-a'} as never, repo)
    recordLlmUsageEvent('conv-1', {...base, inputTokens: 3, outputTokens: 3, messageId: 'm-b'} as never, repo)

    const recs = (repo.record as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as LlmUsageRecord)
    expect(recs.map(r => r.id)).toEqual(['usage_m-a_0', 'usage_m-a_1', 'usage_m-b_0'])
  })

  it('messageId 缺失（防御）→ 跳过不写', async () => {
    const recordLlmUsageEvent = await freshRecord()
    const repo = {record: vi.fn()}
    recordLlmUsageEvent('conv-1', {
      type: 'llm_call_done',
      providerType: 'openai',
      model: 'gpt-4o',
      duration: 1,
      inputTokens: 1,
      outputTokens: 1,
    } as never, repo)
    expect(repo.record).not.toHaveBeenCalled()
  })
})

/**
 * ★S5：消息终结释放 seq 记账（resetUsageMsgState）。
 *
 * 背景：seqByMessage 此前随应用寿命单调增长（每条 assistant 消息残留一个 key），
 * 违反「flush ≠ delete」。修复：finalize 成功时（与 resetBridgeMsgState 同条件）
 * 调用 resetUsageMsgState 释放该 messageId 的 seq 记账。
 * 防御：释放后若仍有迟到 llm_call_done 到达同一 messageId，seq 会从 0 重算并撞
 * 已有幂等键 usage_<msgId>_0 被 INSERT OR IGNORE 丢弃 → 故保留一份有界的
 * 「已终结」集合，迟到事件命中即 logger.warn（不静默丢弃、不抛错、不改 seq 语义）。
 * 正常流程不可达（事件按序处理 + messageId 不复用），故仅做可观测化。
 */
describe('resetUsageMsgState（S5 消息终结释放 seq 记账）', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const usageEvent = (messageId: string, inputTokens: number) => ({
    type: 'llm_call_done',
    providerType: 'openai',
    model: 'gpt-4o',
    duration: 1,
    inputTokens,
    outputTokens: inputTokens,
    messageId,
  } as never)

  it('reset 后同一 messageId 的 seq 重新从 0 开始', async () => {
    const {recordLlmUsageEvent, resetUsageMsgState} = await import('@/main/usageWrite')
    const repo = {record: vi.fn()}

    recordLlmUsageEvent('conv-1', usageEvent('m-1', 1), repo)
    recordLlmUsageEvent('conv-1', usageEvent('m-1', 2), repo)
    resetUsageMsgState('m-1')           // 消息终结 → 释放
    recordLlmUsageEvent('conv-1', usageEvent('m-1', 3), repo)   // 复用同 id：从 0 重算

    const ids = (repo.record as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[0] as LlmUsageRecord).id)
    expect(ids).toEqual(['usage_m-1_0', 'usage_m-1_1', 'usage_m-1_0'])
  })

  it('reset 只影响目标 messageId，其它 messageId 的 seq 不受影响', async () => {
    const {recordLlmUsageEvent, resetUsageMsgState} = await import('@/main/usageWrite')
    const repo = {record: vi.fn()}

    recordLlmUsageEvent('conv-1', usageEvent('m-a', 1), repo)
    recordLlmUsageEvent('conv-1', usageEvent('m-b', 1), repo)
    resetUsageMsgState('m-a')
    recordLlmUsageEvent('conv-1', usageEvent('m-b', 2), repo)

    const ids = (repo.record as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[0] as LlmUsageRecord).id)
    expect(ids).toEqual(['usage_m-a_0', 'usage_m-b_0', 'usage_m-b_1'])
  })

  it('终结后的迟到事件：命中防御 → warn 且仍写入，不静默丢弃、不抛错', async () => {
    const {logger} = await import('@/main/agent/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const {recordLlmUsageEvent, resetUsageMsgState} = await import('@/main/usageWrite')
      const repo = {record: vi.fn()}

      recordLlmUsageEvent('conv-1', usageEvent('m-1', 1), repo)   // seq 0
      recordLlmUsageEvent('conv-1', usageEvent('m-1', 2), repo)   // seq 1
      resetUsageMsgState('m-1')                                    // 终结 → 释放记账
      recordLlmUsageEvent('conv-1', usageEvent('m-1', 3), repo)   // 迟到事件

      const ids = (repo.record as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[0] as LlmUsageRecord).id)
      // 迟到事件仍被写入（非静默跳过）；seq 语义不变（reset 后从 0 起）
      expect(ids).toEqual(['usage_m-1_0', 'usage_m-1_1', 'usage_m-1_0'])
      // 关键：必须留下告警，使该异常可观测（否则 DB 侧 INSERT OR IGNORE 会静默吞掉）
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]![0]).toContain('迟到 llm_call_done')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('无 messageId 的终结调用（防御）不抛错', async () => {
    const {resetUsageMsgState} = await import('@/main/usageWrite')
    expect(() => resetUsageMsgState('')).not.toThrow()
  })

  /**
   * ★V2-B：迟到事件不得"复活"已释放的 seq key。
   *
   * 缺陷：迟到分支此前 warn 后仍 `seqByMessage.set(messageId, seq+1)`，把 reset 时
   * delete 掉的 key 重新建回；该消息已终结、不会再有 finalize → 无释放路径 → 永久残留。
   *
   * 观察手段（不改封装）：连续两条迟到事件。
   * - key 已不残留 → 两条都从 0 起算，幂等键均为 usage_m-1_0；
   * - key 被复活残留（修复前）→ 第二条会读到 seq=1 → usage_m-1_1。
   * 仍保留既有可观测行为：每条迟到事件都 warn（不静默）、不抛错。
   */
  it('★V2-B：迟到事件不再残留 seq key（连续两条迟到事件都从 0 起算）', async () => {
    const {logger} = await import('@/main/agent/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const {recordLlmUsageEvent, resetUsageMsgState} = await import('@/main/usageWrite')
      const repo = {record: vi.fn()}

      recordLlmUsageEvent('conv-1', usageEvent('m-1', 1), repo)   // seq 0
      resetUsageMsgState('m-1')                                    // 终结 → 释放记账
      recordLlmUsageEvent('conv-1', usageEvent('m-1', 2), repo)   // 迟到#1
      recordLlmUsageEvent('conv-1', usageEvent('m-1', 3), repo)   // 迟到#2

      const ids = (repo.record as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[0] as LlmUsageRecord).id)
      expect(ids).toEqual(['usage_m-1_0', 'usage_m-1_0', 'usage_m-1_0'])
      // 既有行为不变：两条迟到事件各自告警一次（不静默）
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  /**
   * ★D3：重复 reset 同一 messageId 不得改变 finalizedMsgIds 的驱逐顺序。
   *
   * 缺陷：resetUsageMsgState 此前无条件 delete+add，cleanup 兜底释放与正常 finalize
   * 会对同一 id 重复调用 → 已终结 id 被刷新到插入序末尾 → FINALIZED_KEEP(256)
   * 驱逐时提前淘汰较新的 id，缩短迟到告警覆盖窗口。
   *
   * 观察手段（不改封装、不导出内部 Set）：以「迟到事件是否命中告警」判定某 id
   * 是否仍在已终结集合中。填满窗口后对最旧的 m-1 二次 reset，再终结一个新 id 触发
   * 一次驱逐：修复后应驱逐插入序最旧的 m-1（其迟到事件不再告警），m-2 / m-256 保留。
   */
  it('★D3：重复 reset 同一 messageId 不改变 finalizedMsgIds 驱逐顺序', async () => {
    const {logger} = await import('@/main/agent/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const {recordLlmUsageEvent, resetUsageMsgState} = await import('@/main/usageWrite')
      const repo = {record: vi.fn()}
      const KEEP = 256
      // 填满窗口：m-1 … m-256，插入序即编号序
      for (let i = 1; i <= KEEP; i++) resetUsageMsgState(`m-${i}`)
      // 重复 reset 最旧的 m-1（对应 cleanup 兜底 + 正常 finalize 对同一 id 的重复调用）
      resetUsageMsgState('m-1')
      // 再终结一个新 id → 触发一次驱逐（应驱逐插入序最旧的 m-1）
      resetUsageMsgState(`m-${KEEP + 1}`)

      const before = warnSpy.mock.calls.length
      for (const id of ['m-1', 'm-2', `m-${KEEP}`]) {
        recordLlmUsageEvent('conv-1', usageEvent(id, 1), repo)
      }
      const warnedIds = warnSpy.mock.calls
        .slice(before)
        .map(c => (c[1] as {messageId: string}).messageId)
      // 修复前：m-1 被二次 reset 刷新到末尾 → 本应被驱逐的它反而保留（仍告警）；
      // 修复后：m-1 保持最旧插入序 → 被驱逐（不告警），m-2 成为新的最旧（保留）
      expect(warnedIds).not.toContain('m-1')
      expect(warnedIds).toContain('m-2')
      expect(warnedIds).toContain(`m-${KEEP}`)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

/**
 * ★V2-A：异常终态兜底释放（cleanup → resetUsageMsgState）。
 *
 * 缺陷：resetUsageMsgState 此前只在 finalize 成功分支（manager.impl.ts:532 / :678）
 * 被调用；worker 崩溃 / abort 超时终止走 cleanup()，直接 delete pendingAssistantMsg，
 * 不经过 finalize → 当前 pending 的 seq 记账永不释放（key 为唯一 UUID，永久残留）。
 *
 * 环境搭建说明（对齐 manager.resultShrink.test.ts）：electron 空壳 + config 重定向
 * tmpdir 隔离；llmUsageRepo 打桩以避免真实 DB 建表依赖。AgentManager 的
 * handleStreamEvent / cleanup 为 TS-private（运行时可访问），经 (manager as any) 驱动，
 * 不 spawn Worker。usageWrite 与 manager 经同一次 resetModules 后动态 import，
 * 保证共享同一模块级 seq 状态。
 */
describe('★V2-A：异常终态兜底释放（cleanup 释放 pending 的 usage seq 记账）', () => {
  const CONV = 'conv-v2a'

  beforeEach(() => {
    vi.doMock('electron', () => ({
      BrowserWindow: class { static getAllWindows() { return [] } },
      app: {getPath: () => '/tmp', isReady: () => true},
      dialog: {showErrorBox: vi.fn()},
      ipcMain: {handle: vi.fn(), on: vi.fn()},
    }))
    vi.doMock('@/main/config', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path')
      const testDir = path.join(os.tmpdir(), 'hclaw-test-usagewrite-v2a-' + Date.now())
      return {
        getHclawDir: () => testDir,
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
      }
    })
    vi.doMock('@/main/repositories/sqlite/llmUsageRepository', () => ({
      llmUsageRepo: {record: vi.fn()},
    }))
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('electron')
    vi.doUnmock('@/main/config')
    vi.doUnmock('@/main/repositories/sqlite/llmUsageRepository')
    vi.resetModules()
  })

  it('cleanup 后同一 messageId 的 seq 记账已释放（迟到上报命中防御且 seq 归 0）', async () => {
    const {AgentManager} = await import('@/main/agent/manager.impl')
    const {recordLlmUsageEvent} = await import('@/main/usageWrite')
    const {logger} = await import('@/main/agent/logger')
    const {llmUsageRepo} = await import('@/main/repositories/sqlite/llmUsageRepository')
    const record = llmUsageRepo.record as unknown as ReturnType<typeof vi.fn>

    const manager = new AgentManager()
    // 经真实事件链路建 pending，并注入一次 llm_call_done（seq 推进到 1）
    await (manager as any).handleStreamEvent(CONV, null, {type: 'text', content: 'hi'})
    const msgId = (manager as any).pendingAssistantMsg.get(CONV).id as string
    expect(msgId).toBeTruthy()
    await (manager as any).handleStreamEvent(CONV, null, {
      type: 'llm_call_done', providerType: 'openai', model: 'gpt-4o',
      duration: 1, inputTokens: 1, outputTokens: 1, messageId: msgId,
    })
    expect((record.mock.calls[0]![0] as LlmUsageRecord).id).toBe(`usage_${msgId}_0`)

    // 异常终态：直接 cleanup（不走 finalize）
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      ;(manager as any).cleanup(CONV)
      expect((manager as any).pendingAssistantMsg.get(CONV)).toBeUndefined()
      // 幂等：重复 cleanup 不得报错
      expect(() => (manager as any).cleanup(CONV)).not.toThrow()

      // 观察释放：同 id 再次上报 → 命中「已终结」防御（warn）且 seq 从 0 重算
      // （修复前：无 warn 且 seq=1 → usage_<msgId>_1，说明 key 从未释放）
      const before = record.mock.calls.length
      recordLlmUsageEvent(CONV, {
        type: 'llm_call_done', providerType: 'openai', model: 'gpt-4o',
        duration: 1, inputTokens: 2, outputTokens: 2, messageId: msgId,
      } as never)
      expect((record.mock.calls[before]![0] as LlmUsageRecord).id).toBe(`usage_${msgId}_0`)
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('迟到 llm_call_done'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

/**
 * llm_usage.provider_id（T4 DB 集成：全新临时库走生产迁移建表/加列，
 * 隔离方式参照 runtimeConfigManager.convPermissionMode.db.test.ts：
 * vi.mock config → getHclawDir() 重定向临时目录，绝不触碰真实 ~/.hclaw）。
 */
describe('llm_usage.provider_id（DB 集成：新库迁移 + 写入 + 聚合透出）', () => {
  it('fresh DB（走迁移建表）写入带 providerId 的 record → 聚合按 (provider, model) 分组并透出 providerId', async () => {
    vi.doMock('@/main/config', () => {
      const os = require('os')
      const path = require('path')
      const testDir = path.join(os.tmpdir(), 'hclaw-test-usagewrite-' + Date.now())
      return {
        getHclawDir: () => testDir,
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
      }
    })
    vi.resetModules()
    const {getDatabase, initDatabaseSync, closeDatabase} = await import('@/main/repositories/sqlite')
    const {llmUsageRepo} = await import('@/main/repositories/sqlite/llmUsageRepository')
    initDatabaseSync()   // 全新临时库：035 建表 + 038 加列迁移路径均被执行
    const db = getDatabase()
    // 外键约束：llm_usage.conversation_id → conversations(id)
    db.prepare(`INSERT OR IGNORE INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES ('c1', '', '{}', 0, 0)`).run()
    const noMeta = () => ({inputPrice: 0, outputPrice: 0, cacheReadPrice: 0})

    const baseRec = {
      conversationId: 'c1', messageId: 'm1',
      providerType: 'openai',
      model: 'gpt-4o',
      outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      durationMs: 100, createdAt: Date.now(),
    }
    llmUsageRepo.record({...baseRec, id: 'usage_pv_0', providerId: 'prov-alpha', providerName: 'Alpha', inputTokens: 10})
    // 同 provider 同 model 第二次调用 → 聚合为一组
    llmUsageRepo.record({...baseRec, id: 'usage_pv_1', providerId: 'prov-alpha', providerName: 'Alpha', inputTokens: 20})
    // 另一服务商同名模型 → 独立分组（分组粒度保持 provider, model，不跨服务商合并）
    llmUsageRepo.record({...baseRec, id: 'usage_pv_2', providerId: 'prov-beta', providerName: 'Beta', inputTokens: 1})

    const rows = llmUsageRepo.queryAggregated({range: 'all', view: 'model'}, noMeta)
    const alpha = rows.find(r => r.providerId === 'prov-alpha')
    const beta = rows.find(r => r.providerId === 'prov-beta')
    expect(alpha).toBeDefined()
    expect(alpha!.requestCount).toBe(2)
    expect(alpha!.inputTokens).toBe(30)
    expect(beta).toBeDefined()
    expect(beta!.requestCount).toBe(1)

    // 迁移生效：provider_id 列存在且持久化
    const row = db.prepare(`SELECT provider_id FROM llm_usage WHERE id = 'usage_pv_0'`).get() as {provider_id: string | null}
    expect(row.provider_id).toBe('prov-alpha')
    try { closeDatabase() } catch { /* ignore */ }
  })
})
