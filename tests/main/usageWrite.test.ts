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
