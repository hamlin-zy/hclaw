/**
 * 性能基线：300 轮增量 vs 全量处理对比
 * 断言两层：
 * 1. 结构性（主）：增量干净轮 process 返回输入数组本身（零拷贝，证明无前缀拷贝）
 * 2. 比值（辅）：增量累计处理时间 ≤ 全量 × 0.6（稳态 O(新增段)/步 vs 全量 O(n)/步）
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import {normalizeToolCallMessages} from '../../../../src/main/agent/state'

const TURNS = 300

function buildHistory(turns: number): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (let turn = 0; turn < turns; turn++) {
    msgs.push({id: `u${turn}`, role: 'user', content: `第${turn + 1}轮用户消息，包含一段较长的指令文本用于模拟真实负载`.repeat(10)})
    msgs.push({id: `a${turn}`, role: 'assistant', content: `第${turn + 1}轮助手回复内容`.repeat(10)})
    if (turn % 3 === 0) {
      msgs.push({id: `t${turn}`, role: 'tool', toolCallId: `tc${turn}`, content: 'file content', toolResult: '文件内容输出'.repeat(20)})
    }
  }
  return msgs
}

describe(`性能基线：${TURNS} 轮增量 vs 全量`, () => {
  it('增量路径零拷贝（结构性断言）且累计耗时 ≤ 全量×0.6', () => {
    const fullHistory = buildHistory(TURNS)
    const cache = new PreprocessCache()

    // 预热：避免 JIT 冷启动污染首轮计时
    {
      const warm = buildHistory(50)
      const warmCache = new PreprocessCache()
      for (let i = 2; i <= warm.length; i += 2) {
        const s = warm.slice(0, i)
        warmCache.process(s)
        normalizeToolCallMessages(s)
      }
    }

    let incrementalProcessed = 0
    let fullProcessed = 0
    for (let i = 2; i <= fullHistory.length; i += 2) {
      const slice = fullHistory.slice(0, i)
      const before = performance.now()
      const out = cache.process(slice)
      incrementalProcessed += (performance.now() - before)

      // 结构性断言：首轮是全量（返回新数组），之后每轮增量干净轮必须零拷贝
      if (i > 2) expect(out).toBe(slice)

      const beforeFull = performance.now()
      normalizeToolCallMessages(slice)
      fullProcessed += (performance.now() - beforeFull)
    }

    console.log(`[perf] 增量累计 ${incrementalProcessed.toFixed(1)}ms vs 全量累计 ${fullProcessed.toFixed(1)}ms`)
    // 比值收紧：稳态增量 O(新增段)/步 应显著快于全量 O(n)/步
    expect(incrementalProcessed).toBeLessThanOrEqual(fullProcessed * 0.6)
  })
})
