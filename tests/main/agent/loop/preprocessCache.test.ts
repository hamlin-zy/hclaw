/**
 * PreprocessCache — 增量 normalize 管道测试
 * 判据：增量输出与全量输出逐条一致
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {normalizeToolCallMessages} from '../../../../src/main/agent/state'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'

function makeUser(idx: number): ChatMessage {
  return {id: `u${idx}`, role: 'user', content: `user ${idx}`}
}
function makeAssistant(idx: number, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
  return {id: `a${idx}`, role: 'assistant', content: `assistant ${idx}`, toolCalls}
}
function makeTool(idx: number, toolCallId: string, content: string): ChatMessage {
  return {id: `t${idx}`, role: 'tool', toolCallId, content, toolResult: content}
}

describe('PreprocessCache — 增量与全量 normalizeToolCallMessages 一致', () => {
  it('纯追加场景：增量输出 === 全量输出', () => {
    const cache = new PreprocessCache()
    const s1 = [makeUser(0), makeAssistant(0, [{id: 'tc1', name: 'bash', arguments: {}}]), makeTool(0, 'tc1', 'ok')]
    expect(cache.process(s1)).toEqual(normalizeToolCallMessages(s1))

    const s2 = [...s1, makeUser(1), makeAssistant(1)]
    expect(cache.process(s2)).toEqual(normalizeToolCallMessages(s2))

    const s3 = [...s2, makeUser(2)]
    expect(cache.process(s3)).toEqual(normalizeToolCallMessages(s3))
  })

  it('孤立 tool_use 场景：增量注入合成结果与全量一致', () => {
    const cache = new PreprocessCache()
    const s1 = [makeUser(0), makeAssistant(0, [{id: 'orphan1', name: 'bash', arguments: {}}])]
    const r1 = cache.process(s1)
    const full1 = normalizeToolCallMessages(s1)
    expect(r1).toEqual(full1)
    expect(full1.some(m => m.role === 'tool' && m.isError)).toBe(true)
  })

  it('合成结果被真实结果取代：增量移除合成，与全量一致', () => {
    const cache = new PreprocessCache()
    // 第一轮：assistant 带 tool_use 但无 tool 结果（孤儿）
    const s1 = [makeUser(0), makeAssistant(0, [{id: 'tc1', name: 'bash', arguments: {}}])]
    cache.process(s1)
    // 第二轮：真实 tool 结果到达（中断恢复场景）
    const s2 = [...s1, makeTool(0, 'tc1', 'real result')]
    const r2 = cache.process(s2)
    const full2 = normalizeToolCallMessages(s2)
    expect(r2).toEqual(full2)
    // 全量结果中 tc1 有真实结果，不应再有 isError 合成消息
    const errorTools = full2.filter(m => m.role === 'tool' && m.isError)
    expect(errorTools.length).toBe(0)
  })

  it('同长度重试：命中缓存返回同一引用', () => {
    const cache = new PreprocessCache()
    const s = [makeUser(0)]
    const r1 = cache.process(s)
    const r2 = cache.process(s)
    expect(r1).toBe(r2)
  })

  it('forceRebuild 后全量重建', () => {
    const cache = new PreprocessCache()
    const s1 = [makeUser(0)]
    cache.process(s1)
    const s2 = [makeUser(0), makeUser(1)]
    const r = cache.process(s2, true)
    expect(r).toEqual(normalizeToolCallMessages(s2))
  })
})
