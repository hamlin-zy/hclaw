import {describe, expect, it} from 'vitest'
import {convertAssistantHistoryMessage} from '@/main/agent/ipc/historyConverter'

function think(id: string, content: string, signature?: string) {
  return {
    id: `cb-think-${id}`,
    type: 'think',
    thinkBlock: {id: `think-${id}`, content, status: 'complete', timestamp: 1, ...(signature ? {signature} : {})},
  }
}

function text(id: string, value: string) {
  return {id: `cb-text-${id}`, type: 'text', text: value}
}

function toolUse(id: string, tc: Record<string, unknown>) {
  return {id: `cb-tool-${id}`, type: 'tool_use', toolCall: tc}
}

describe('convertAssistantHistoryMessage — contentBlocks 多段重建', () => {
  it('按 think 边界还原多个 assistant，reasoning 逐字节一致', () => {
    const msg = {
      role: 'assistant',
      content: '正文1正文2正文3',
      contentBlocks: [
        think('1', '第一段 reasoning'),
        text('1', '正文1'),
        toolUse('1', {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}, status: 'success', result: {output: 'ok1'}}),
        think('2', '第二段 reasoning'),
        text('2', '正文2'),
        toolUse('2', {id: 'tc-2', name: 'file_read', arguments: {filePath: 'a'}, status: 'success', result: {output: 'ok2'}}),
        toolUse('3', {id: 'tc-3', name: 'grep', arguments: {pattern: 'x'}, status: 'success', result: {output: 'ok3'}}),
        think('3', '第三段 reasoning'),
        text('3', '正文3'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)

    const assistants = result.filter(m => m.role === 'assistant')
    const tools = result.filter(m => m.role === 'tool')

    expect(assistants).toHaveLength(3)
    expect(tools).toHaveLength(3)

    // reasoning 逐字节一致（不做 split/filter/join 改写）
    expect(assistants[0].reasoningContent).toBe('第一段 reasoning')
    expect(assistants[1].reasoningContent).toBe('第二段 reasoning')
    expect(assistants[2].reasoningContent).toBe('第三段 reasoning')

    // content 按段还原
    expect(assistants[0].content).toBe('正文1')
    expect(assistants[1].content).toBe('正文2')
    expect(assistants[2].content).toBe('正文3')

    // toolCalls 分组：第 1 段 1 个，第 2 段 2 个，第 3 段 0 个
    expect(assistants[0].toolCalls).toHaveLength(1)
    expect(assistants[1].toolCalls).toHaveLength(2)
    expect(assistants[2].toolCalls).toBeUndefined()

    // tool 消息顺序与 tool_use 一致
    expect(tools[0].toolCallId).toBe('tc-1')
    expect(tools[1].toolCallId).toBe('tc-2')
    expect(tools[2].toolCallId).toBe('tc-3')
    expect(tools[0].toolResult).toBe('ok1')
    expect(tools[1].toolResult).toBe('ok2')
    expect(tools[2].toolResult).toBe('ok3')
  })

  it('reasoning 含空行时原样保留（旧逻辑 split+filter 会丢空行）', () => {
    const rawReasoning = '第一行\n\n第三行\n\n\n结尾'
    const msg = {
      role: 'assistant',
      content: '正文',
      contentBlocks: [
        think('1', rawReasoning),
        text('1', '正文'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    expect(result).toHaveLength(1)
    expect(result[0].reasoningContent).toBe(rawReasoning)
  })

  it('think 块带 signature 时走 thinking + thinkingSignature（Anthropic）', () => {
    const msg = {
      role: 'assistant',
      content: '正文',
      contentBlocks: [
        think('1', 'anthropic 思考', 'sig-123'),
        text('1', '正文'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    expect(result).toHaveLength(1)
    expect(result[0].thinking).toBe('anthropic 思考')
    expect(result[0].thinkingSignature).toBe('sig-123')
    expect(result[0].reasoningContent).toBeUndefined()
  })
})

describe('convertAssistantHistoryMessage — 扁平字段 fallback', () => {
  it('无 contentBlocks 时走旧扁平路径，返回 1 个 assistant + tool', () => {
    const msg = {
      role: 'assistant',
      content: '正文',
      thinkBlock: {id: 'think-1', content: '唯一思考', status: 'complete', timestamp: 1},
      toolCalls: [
        {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}, status: 'success', result: {output: 'ok'}},
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    const tools = result.filter(m => m.role === 'tool')

    expect(assistants).toHaveLength(1)
    expect(assistants[0].reasoningContent).toBe('唯一思考')
    expect(assistants[0].toolCalls).toHaveLength(1)
    expect(tools).toHaveLength(1)
    expect(tools[0].toolResult).toBe('ok')
  })

  it('toolCall 缺少 result 时生成合成错误结果', () => {
    const msg = {
      role: 'assistant',
      content: '',
      toolCalls: [
        {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}, status: 'running'},
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const tools = result.filter(m => m.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].isError).toBe(true)
    // 与 loop 内 normalizeToolCallMessages 的合成文案保持一致（缓存一致性）
    expect(tools[0].toolResult).toContain('[INTERRUPTED]')
  })

  it('首个 think 的 reasoning 为空字符串时边界仍保留', () => {
    const msg = {
      role: 'assistant',
      content: '前段正文后段正文',
      contentBlocks: [
        think('1', ''),
        text('1', '前段正文'),
        think('2', '第二段 reasoning'),
        text('2', '后段正文'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0].reasoningContent).toBeUndefined()
    expect(assistants[0].content).toBe('前段正文')
    expect(assistants[1].reasoningContent).toBe('第二段 reasoning')
    expect(assistants[1].content).toBe('后段正文')
  })

  it('contentBlocks 以 text/tool_use 开头（无前导 think）时不丢内容', () => {
    const msg = {
      role: 'assistant',
      content: '开场白开场文',
      contentBlocks: [
        text('1', '开场白'),
        toolUse('1', {id: 'tc-1', name: 'bash', arguments: {command: 'ls'}, status: 'success', result: {output: 'ok'}}),
        think('2', '后续 reasoning'),
        text('2', '开场文'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    const assistants = result.filter(m => m.role === 'assistant')
    const tools = result.filter(m => m.role === 'tool')

    expect(assistants).toHaveLength(2)
    // 首段无 reasoning，保留 text + toolCalls
    expect(assistants[0].reasoningContent).toBeUndefined()
    expect(assistants[0].content).toBe('开场白')
    expect(assistants[0].toolCalls).toHaveLength(1)
    expect(tools).toHaveLength(1)
    expect(tools[0].toolResult).toBe('ok')
    // 第二段有 think
    expect(assistants[1].reasoningContent).toBe('后续 reasoning')
    expect(assistants[1].content).toBe('开场文')
  })

  it('纯 media 块被跳过，空段不输出', () => {
    const msg = {
      role: 'assistant',
      content: '正文',
      contentBlocks: [
        {id: 'cb-media-1', type: 'media', media: {type: 'image', url: 'hclaw-media://x.png'}},
        text('1', '正文'),
      ],
    }

    const result = convertAssistantHistoryMessage(msg)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
    expect(result[0].content).toBe('正文')
  })
})
