/**
 * 回归测试：OpenAIAdapter 增量转换缓存（AdapterConvertCache）内容感知
 *
 * 背景（2026-08-14 opencode 网关 400）：
 *   provider (Console Go / GO-OpenAI) 报
 *   "Messages with role 'tool' must be a response to a preceding message with role 'tool_calls'"
 *   根因：convertCache 只以 messages.length 为缓存键，无法感知前缀内容变化。
 *   normalize（PreprocessCache）合成注入/取代（[INTERRUPTED] ↔ 真实结果）发生在
 *   adapter 之前，改变了前缀的 tool 结果内容；adapter 同长度命中返回过期前缀，
 *   与新增段拼接后可能产生孤儿 tool 消息。
 *
 * 修复：convertMessages 增加「前缀结构指纹」（role + tool 关联 id + tool 结果
 * 内容指纹），长度相等但内容变化时全量重建，保证 增量输出 === 全量输出。
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {OpenAIAdapter} from '../../../../src/main/agent/model/openaiAdapter'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'

function makeUser(text: string): ChatMessage {
  return {role: 'user', content: text}
}
function makeAssistant(text: string, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
  return {role: 'assistant', content: text, toolCalls}
}
function makeTool(id: string, result: string): ChatMessage {
  return {role: 'tool', toolCallId: id, content: result, toolResult: result}
}

/** 检查 OpenAI 格式消息序列：每个 tool 消息之前（跳过连续 tool 块）必须是含匹配 tool_calls 的 assistant */
function assertNoOrphanTool(apiMessages: any[]): void {
  for (let i = 0; i < apiMessages.length; i++) {
    const m = apiMessages[i]
    if (m.role !== 'tool') continue
    let j = i - 1
    while (j >= 0 && apiMessages[j].role === 'tool') j--
    const prev = apiMessages[j]
    expect(prev, `index ${i} 的 tool 消息前无 assistant/tool_calls 块`).toBeDefined()
    expect(prev.role, `index ${i} 前一条 role 应为 assistant`).toBe('assistant')
    const ids = (prev.tool_calls || []).map((tc: any) => tc.id)
    expect(ids, `index ${i} 的 tool_call_id=${m.tool_call_id} 未在前一条 tool_calls 中`).toContain(m.tool_call_id)
  }
}

describe('OpenAIAdapter convertCache 内容感知（孤儿 tool 回归）', () => {
  it('合成注入后同长度取代 → adapter 全量重建而非返回过期内容', () => {
    const pcache = new PreprocessCache()
    const adapter = new OpenAIAdapter({apiKey: 'test', model: 'gpt-4o', provider: 'openai', baseUrl: ''} as any)

    // 第 1 轮：assistant 声明 tc1/tc2，仅 tc1 有结果 → normalize 注入 tc2 合成
    const s1: ChatMessage[] = [
      makeUser('u1'),
      makeAssistant('', [{id: 'tc1', name: 'bash', arguments: {}}, {id: 'tc2', name: 'bash', arguments: {}}]),
      makeTool('tc1', 'r1'),
    ]
    const out1 = pcache.process(s1)
    const r1 = adapter.convertMessagesForTest(out1)
    assertNoOrphanTool(r1)

    // 第 2 轮：tc2 真实结果到达，输入长度相同但内容变化（合成→真实）
    const s2: ChatMessage[] = [...s1, makeTool('tc2', 'r2')]
    const out2 = pcache.process(s2)
    const r2 = adapter.convertMessagesForTest(out2)
    const r2Full = adapter.convertMessagesForTestFull(out2)
    // 增量输出必须 === 全量输出（真实结果，非 [INTERRUPTED] 合成）
    expect(r2).toEqual(r2Full)
    assertNoOrphanTool(r2)
    const tc2Msg = r2.find((m: any) => m.role === 'tool' && m.tool_call_id === 'tc2')
    expect(tc2Msg).toBeDefined()
    expect((tc2Msg as any).content).toBe('r2')
  })

  it('前缀取代 + 尾部新增 → 增量追加不错位，输出与全量一致', () => {
    const pcache = new PreprocessCache()
    const adapter = new OpenAIAdapter({apiKey: 'test', model: 'gpt-4o', provider: 'openai', baseUrl: ''} as any)

    const s1: ChatMessage[] = [
      makeUser('u1'),
      makeAssistant('', [{id: 'tc1', name: 'bash', arguments: {}}, {id: 'tc2', name: 'bash', arguments: {}}]),
      makeTool('tc1', 'r1'),
    ]
    adapter.convertMessagesForTest(pcache.process(s1))

    // 第 2 轮：tc2 真实结果 + 新 user（前缀取代 + 尾部新增）
    const s2: ChatMessage[] = [...s1, makeTool('tc2', 'r2'), makeUser('u2')]
    const out2 = pcache.process(s2)
    const r2 = adapter.convertMessagesForTest(out2)
    const r2Full = adapter.convertMessagesForTestFull(out2)
    expect(r2).toEqual(r2Full)
    assertNoOrphanTool(r2)
  })

  it('纯追加跨轮次 tool 结果（对照：增量路径保持有效）', () => {
    const adapter = new OpenAIAdapter({apiKey: 'test', model: 'gpt-4o', provider: 'openai', baseUrl: ''} as any)
    const t1: ChatMessage[] = [makeUser('hi')]
    adapter.convertMessagesForTest(t1)
    const t2: ChatMessage[] = [...t1, makeAssistant('', [{id: 'tc1', name: 'bash', arguments: {}}, {id: 'tc2', name: 'bash', arguments: {}}])]
    adapter.convertMessagesForTest(t2)
    const t3: ChatMessage[] = [...t2, makeTool('tc1', 'r1')]
    adapter.convertMessagesForTest(t3)
    const t4: ChatMessage[] = [...t3, makeTool('tc2', 'r2'), makeUser('继续')]
    const r4 = adapter.convertMessagesForTest(t4)
    assertNoOrphanTool(r4)
  })
})
