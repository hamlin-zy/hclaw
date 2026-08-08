/**
 * PreprocessCache — 增量 normalize 管道测试
 * 判据：增量输出与全量输出逐条一致
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {normalizeToolCallMessages, isSyntheticToolResult} from '../../../../src/main/agent/state'
import {PreprocessCache, normalizeIncremental} from '../../../../src/main/agent/loop/preprocessCache'

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

describe('PreprocessCache — 增长场景增量路径（方案 A）', () => {
  it('混合场景顺序：同一 assistant 部分真实结果部分孤儿，增量输出 === 全量输出', () => {
    const cache = new PreprocessCache()
    const s1 = [makeUser(0), makeAssistant(0)]
    cache.process(s1)
    const s2 = [
      ...s1,
      makeAssistant(1, [
        {id: 'tc1', name: 'bash', arguments: {}},
        {id: 'tc2', name: 'bash', arguments: {}},
      ]),
      makeTool(1, 'tc1', 'ok'),
    ]
    const r2 = cache.process(s2)
    const full2 = normalizeToolCallMessages(s2)
    expect(r2).toEqual(full2)
    // 全量版语义：合成消息插在连续 tool 消息之后 → [a1, tool(tc1), syn(tc2)]
    const a1Idx = full2.findIndex(m => m.id === 'a1')
    expect(full2[a1Idx + 1]!.toolCallId).toBe('tc1')
    expect(full2[a1Idx + 1]!.isError).toBeUndefined()
    expect(full2[a1Idx + 2]!.isError).toBe(true)
    expect(full2[a1Idx + 2]!.toolCallId).toBe('tc2')
  })

  it('零拷贝：增量轮前缀干净且无孤儿时返回输入数组本身', () => {
    const cache = new PreprocessCache()
    const s1 = [makeUser(0), makeAssistant(0)]
    cache.process(s1) // 全量轮建立缓存
    const s2 = [...s1, makeUser(1)]
    const r2 = cache.process(s2) // 增量轮：无孤儿、前缀干净 → 零拷贝
    expect(r2).toBe(s2)
    // 同长度重试命中返回同一引用
    expect(cache.process(s2)).toBe(s2)
  })

  it('Object.freeze 输入：增量零拷贝轮返回冻结数组本身且不抛错', () => {
    const cache = new PreprocessCache()
    const s1 = [makeUser(0), makeAssistant(0)]
    cache.process(s1) // 全量轮建立缓存
    const s2 = Object.freeze([...s1, makeUser(1)])
    const r2 = cache.process(s2)
    expect(r2).toBe(s2)
    expect(Object.isFrozen(r2)).toBe(true)
    // 冻结数组上再次增长仍安全（slice/filter 均产生新数组）
    const s3 = [...s2, makeUser(2)]
    const r3 = cache.process(s3)
    expect(r3).toEqual(normalizeToolCallMessages(s3))
  })

  it('Set 原地复用：增量路径不重建全量 Set（结构性断言）', () => {
    const s1 = [makeUser(0), makeAssistant(0, [{id: 'tc1', name: 'bash', arguments: {}}]), makeTool(0, 'tc1', 'ok')]
    const s2 = [...s1, makeUser(1)]
    const cached = normalizeToolCallMessages(s1)
    const resultIds = new Set<string>(['tc1'])
    const syntheticIds = new Set<string>()
    const out = normalizeIncremental(s2, s1.length, cached, resultIds, syntheticIds)
    // 同一 Set 实例被原地更新（证明不重建全量 Set）
    expect(out.resultIds).toBe(resultIds)
    expect(out.syntheticIds).toBe(syntheticIds)
    expect(out.resultIds.has('tc1')).toBe(true)
    expect(out.zeroCopy).toBe(true)
    expect(out.result).toBe(s2)
    expect(out.result).toEqual(normalizeToolCallMessages(s2))
  })

  it('脏前缀稳态：前缀含合成消息且本轮干净时输出仍含合成消息', () => {
    const cache = new PreprocessCache()
    // 第一轮：孤儿注入 → syntheticIds 含 orphan1
    const s1 = [makeUser(0), makeAssistant(0, [{id: 'orphan1', name: 'bash', arguments: {}}])]
    const r1 = cache.process(s1)
    expect(r1.some(m => m.role === 'tool' && m.isError)).toBe(true)
    // 第二轮：追加用户消息（无孤儿、无取代）→ 脏前缀稳态，不零拷贝但语义正确
    const s2 = [...s1, makeUser(1)]
    const r2 = cache.process(s2)
    expect(r2).toEqual(normalizeToolCallMessages(s2))
    expect(r2.filter(m => m.role === 'tool' && m.isError).length).toBe(1)
    expect(r2).not.toBe(s2)
  })

  it('取代过滤收紧：前缀含真实失败结果（isError=true）不误删', () => {
    const cache = new PreprocessCache()
    // 第一轮：tc1 有真实失败结果（content 非空 → 非合成）
    const s1 = [
      makeUser(0),
      makeAssistant(0, [{id: 'tc1', name: 'bash', arguments: {}}]),
      {id: 't0', role: 'tool', toolCallId: 'tc1', content: 'stderr 输出', toolResult: '命令执行失败', isError: true},
    ]
    cache.process(s1)
    // 第二轮：追加消息，无取代交集 → 真实失败结果保留
    const s2 = [...s1, makeUser(1)]
    const r2 = cache.process(s2)
    expect(r2).toEqual(normalizeToolCallMessages(s2))
    expect(r2.filter(m => m.role === 'tool' && m.toolCallId === 'tc1').length).toBe(1)
  })
})
