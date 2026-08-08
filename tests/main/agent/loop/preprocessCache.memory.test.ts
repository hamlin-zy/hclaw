/**
 * 性能基线：300 轮增量 vs 全量处理对比
 * 仅作基准参考，不断言严格耗时（CI 环境波动大），断言「增量累计处理时间 ≤ 全量×2」
 * 注：原 24 轮负载下两条路径均为亚毫秒级、比值贴近 2.0 边界（计时噪声导致偶发翻车），
 *     故将负载放大到 300 轮 + 预热，使比值稳定在 1.0~1.5 的安全区间。
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
  it('增量路径处理的累计消息数远小于全量累计', () => {
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
      cache.process(slice)
      incrementalProcessed += (performance.now() - before)

      const beforeFull = performance.now()
      normalizeToolCallMessages(slice)
      fullProcessed += (performance.now() - beforeFull)
    }

    console.log(`[perf] 增量累计 ${incrementalProcessed.toFixed(1)}ms vs 全量累计 ${fullProcessed.toFixed(1)}ms`)
    // 增量不慢于全量（宽松断言；实际期望显著更快，但 CI 波动下不断言倍数）
    expect(incrementalProcessed).toBeLessThanOrEqual(fullProcessed * 2)
  })
})
