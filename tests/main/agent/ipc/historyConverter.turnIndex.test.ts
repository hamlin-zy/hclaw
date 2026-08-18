import {describe, expect, it} from 'vitest'
import {convertAssistantHistoryMessage, groupByTurnIndex} from '@/main/agent/ipc/historyConverter'

function think(id: string, content: string, turnIndex?: number) {
  return {
    id: `cb-think-${id}`,
    type: 'think',
    turnIndex,
    thinkBlock: {id: `think-${id}`, content, status: 'complete', timestamp: 1},
  }
}

function text(id: string, value: string, turnIndex?: number) {
  return {id: `cb-text-${id}`, type: 'text', text: value, turnIndex}
}

function toolUse(id: string, tc: Record<string, unknown>, turnIndex?: number) {
  return {id: `cb-tool-${id}`, type: 'tool_use', toolCall: tc, turnIndex}
}

describe('convertAssistantHistoryMessage — 按 turnIndex 无损还原多 assistant（方案 2 根治）', () => {
  it('无 think 的独立调用轮（tool_result→tool_call）按 turnIndex 还原为独立 assistant', () => {
    const msg = {
      role: 'assistant',
      content: '正文1正文2',
      contentBlocks: [
        think('1', '第一段 reasoning', 0),
        text('1', '正文1', 0),
        toolUse('1', {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}, status: 'success', result: {output: 'ok1'}}, 0),
        // turn 1：无 think 的纯工具轮（DeepSeek 无 reasoning 调用）
        toolUse('2', {id: 'tc-2', name: 'file_read', arguments: {filePath: 'a'}, status: 'success', result: {output: 'ok2'}}, 1),
        // turn 2：无 think 的 text+tool 轮
        text('2', '正文2', 2),
        toolUse('3', {id: 'tc-3', name: 'grep', arguments: {pattern: 'x'}, status: 'success', result: {output: 'ok3'}}, 2),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    const tools = result.filter(m => m.role === 'tool')

    // ★ 关键断言：3 个 turn → 3 个独立 assistant（修复前只有 1 个，无 think 轮被吞并）
    expect(assistants).toHaveLength(3)
    expect(tools).toHaveLength(3)

    // turn 0：带 reasoning
    expect(assistants[0].reasoningContent).toBe('第一段 reasoning')
    expect(assistants[0].content).toBe('正文1')
    expect(assistants[0].toolCalls).toHaveLength(1)
    expect(assistants[0].toolCalls![0].id).toBe('tc-1')

    // turn 1：无 think、无 text，只有 toolCalls
    expect(assistants[1].reasoningContent).toBeUndefined()
    expect(assistants[1].content).toBe('')
    expect(assistants[1].toolCalls).toHaveLength(1)
    expect(assistants[1].toolCalls![0].id).toBe('tc-2')

    // turn 2：无 think、有 text + toolCalls
    expect(assistants[2].reasoningContent).toBeUndefined()
    expect(assistants[2].content).toBe('正文2')
    expect(assistants[2].toolCalls).toHaveLength(1)
    expect(assistants[2].toolCalls![0].id).toBe('tc-3')

    // tool 消息顺序与 tool_use 一致
    expect(tools.map(t => t.toolCallId)).toEqual(['tc-1', 'tc-2', 'tc-3'])
  })

  it('同 turn 内多个 tool_use 归属同一条 assistant（不拆分）', () => {
    const msg = {
      role: 'assistant',
      content: '正文',
      contentBlocks: [
        think('1', 'reasoning', 0),
        text('1', '正文', 0),
        toolUse('1', {id: 'tc-1', name: 'bash', arguments: {}, status: 'success', result: {output: 'a'}}, 0),
        toolUse('2', {id: 'tc-2', name: 'grep', arguments: {}, status: 'success', result: {output: 'b'}}, 0),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].toolCalls).toHaveLength(2)
    expect(result.filter(m => m.role === 'tool')).toHaveLength(2)
  })

  it('turnIndex 缺失时回退 think 边界切段（旧数据兼容）', () => {
    const msg = {
      role: 'assistant',
      content: '正文1正文2',
      contentBlocks: [
        think('1', '第一段 reasoning'),
        text('1', '正文1'),
        think('2', '第二段 reasoning'),
        text('2', '正文2'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0].reasoningContent).toBe('第一段 reasoning')
    expect(assistants[1].reasoningContent).toBe('第二段 reasoning')
  })

  it('turnIndex 部分缺失时：有 turnIndex 的按 turnIndex，无的并入最近 turn（混合兼容）', () => {
    const msg = {
      role: 'assistant',
      content: '',
      contentBlocks: [
        think('1', 'reasoning', 0),
        toolUse('1', {id: 'tc-1', name: 'bash', arguments: {}, status: 'success', result: {output: 'a'}}, 0),
        // 无 turnIndex 的块（旧数据回填前的过渡态）→ 并入前一个 turn
        toolUse('2', {id: 'tc-2', name: 'grep', arguments: {}, status: 'success', result: {output: 'b'}}),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].toolCalls).toHaveLength(2)
  })

  it('turnIndex 顺序乱序（异步落库）时按 turnIndex 稳定分组', () => {
    const msg = {
      role: 'assistant',
      content: '',
      contentBlocks: [
        toolUse('2', {id: 'tc-2', name: 'grep', arguments: {}, status: 'success', result: {output: 'b'}}, 1),
        think('1', 'reasoning', 0),
        toolUse('1', {id: 'tc-1', name: 'bash', arguments: {}, status: 'success', result: {output: 'a'}}, 0),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0].toolCalls![0].id).toBe('tc-1')
    expect(assistants[1].toolCalls![0].id).toBe('tc-2')
    // tool 消息顺序 = turn 升序 + 组内顺序
    expect(result.filter(m => m.role === 'tool').map(t => t.toolCallId)).toEqual(['tc-1', 'tc-2'])
  })
})

describe('groupByTurnIndex — 纯分组函数', () => {
  it('按 turnIndex 分组保留组内原始顺序', () => {
    const blocks = [
      {type: 'think', id: 'a', turnIndex: 0},
      {type: 'text', id: 'b', turnIndex: 0},
      {type: 'tool_use', id: 'c', turnIndex: 1},
      {type: 'tool_use', id: 'd', turnIndex: 0},
    ]
    const groups = groupByTurnIndex(blocks as any)
    expect([...groups.keys()]).toEqual([0, 1])
    expect(groups.get(0)!.map((b: any) => b.id)).toEqual(['a', 'b', 'd'])
    expect(groups.get(1)!.map((b: any) => b.id)).toEqual(['c'])
  })

  it('空数组返回空 Map', () => {
    expect(groupByTurnIndex([]).size).toBe(0)
  })

  it('全部无 turnIndex 时返回空 Map（走 think 边界 fallback）', () => {
    const blocks = [
      {type: 'think', id: 'a'},
      {type: 'text', id: 'b'},
    ]
    expect(groupByTurnIndex(blocks as any).size).toBe(0)
  })
})

describe('end 块（收尾哨兵）不干扰轮次重建', () => {
  function endBlock(turnIndex?: number) {
    return {id: `cb-end`, type: 'end', endedAt: 1786984426335, turnIndex}
  }

  it('end 块被 sequence 挤在 text 与 tool_call 之间（历史 bug 场景）时不并入任何轮次组', () => {
    // 复刻真实库：第一轮 turn3 的块序 text → end → tool_call（end 的 sequence 小于 tool_call）
    const msg = {
      role: 'assistant',
      content: '已修改，提交信息不再包含"（合并 4 提交）"。',
      contentBlocks: [
        think('1', '用户要求修改 commit message', 0),
        text('1', '修改提交信息，去掉后缀：', 0),
        endBlock(), // ← end 被 finalize resolveSeq 挤在 text 与 tool_call 之间
        toolUse('1', {id: 'tc-1', name: 'bash', arguments: {command: 'git commit --amend'}, status: 'success', result: {output: '[develop 0217ab6]'}}, 0),
        text('2', '已修改，提交信息不再包含"（合并 4 提交）"。', 1),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    const tools = result.filter(m => m.role === 'tool')

    // end 块不产出消息：仍精确还原 2 个轮次
    expect(assistants).toHaveLength(2)
    expect(tools).toHaveLength(1)

    // turn 0：text + toolCall 保持同一 assistant（end 不拆轮）
    expect(assistants[0].content).toBe('修改提交信息，去掉后缀：')
    expect(assistants[0].toolCalls).toHaveLength(1)
    expect(assistants[0].toolCalls![0].id).toBe('tc-1')
    // turn 1：纯文本轮（end 不并入 turn 1 改变其内容）
    expect(assistants[1].content).toBe('已修改，提交信息不再包含"（合并 4 提交）"。')
    expect(assistants[1].toolCalls).toBeUndefined()
  })

  it('end 块在消息末尾（正常落库顺序）时行为不变', () => {
    const msg = {
      role: 'assistant',
      content: 'ok',
      contentBlocks: [
        text('1', '正文', 0),
        endBlock(),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].content).toBe('正文')
  })

  it('无 turnIndex 的旧数据 fallback（think 边界）也跳过 end 块', () => {
    const msg = {
      role: 'assistant',
      content: 'ok',
      contentBlocks: [
        think('1', 'reasoning A'),
        text('1', '正文A'),
        endBlock(), // 无 turnIndex 旧数据中的 end（think 边界切段路径）
        think('2', 'reasoning B'),
        text('2', '正文B'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    // end 不触发新切段：仍为 2 段（think 边界）
    expect(assistants).toHaveLength(2)
    expect(assistants.map(a => a.content)).toEqual(['正文A', '正文B'])
  })
})
