import {describe, expect, it, vi, beforeEach} from 'vitest'
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
