import {describe, expect, it} from 'vitest'
import {restoreSkillSystemMessages, type HistoryChatMessage, type HistoryToolCall} from '@/main/agent/ipc/historyConverter'

describe('restoreSkillSystemMessages — 原样还原 skill 工具的 system 注入消息（KV cache 前缀一致性）', () => {
  it('skill 工具调用：从 result.output 恢复 guidance 作为 system 消息，追加到 tool 消息之后', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill', name: 'skill', arguments: {skill: 'systematic-debugging'}, result: {output: '# systematic-debugging\n完整技能指导', toolResult: '# systematic-debugging\n完整技能指导'}},
        {id: 'tc-bash', name: 'bash', arguments: {command: 'ls'}, result: {output: 'ok'}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc-skill', name: 'skill', arguments: {}}, {id: 'tc-bash', name: 'bash', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill', toolResult: '# systematic-debugging\n完整技能指导'},
      {role: 'tool', content: '', toolCallId: 'tc-bash', toolResult: 'ok'},
    ]

    restoreSkillSystemMessages(msg, converted)

    // 只恢复 skill 的 system 消息，追加到末尾（tool 之后），内容 = guidance
    expect(converted).toHaveLength(4)
    const sysMsg = converted[converted.length - 1]
    expect(sysMsg.role).toBe('system')
    expect(sysMsg.content).toBe('# systematic-debugging\n完整技能指导')
  })

  it('guidance 为空时跳过（不注入空 system 消息）', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill', name: 'skill', arguments: {}, result: {output: ''}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc-skill', name: 'skill', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill', toolResult: ''},
    ]

    restoreSkillSystemMessages(msg, converted)

    expect(converted).toHaveLength(2)
  })

  it('非 skill 工具（bash/agent 等）不注入 system 消息', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-bash', name: 'bash', arguments: {}, result: {output: 'ok'}},
        {id: 'tc-agent', name: 'agent', arguments: {}, result: {output: 'done'}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc-bash', name: 'bash', arguments: {}}, {id: 'tc-agent', name: 'agent', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-bash', toolResult: 'ok'},
      {role: 'tool', content: '', toolCallId: 'tc-agent', toolResult: 'done'},
    ]

    restoreSkillSystemMessages(msg, converted)

    expect(converted).toHaveLength(3)
    expect(converted.some(m => m.role === 'system')).toBe(false)
  })

  it('result 为字符串时直接作为 guidance', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill', name: 'skill', arguments: {}, result: '# 字符串形式技能内容'},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc-skill', name: 'skill', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill', toolResult: '# 字符串形式技能内容'},
    ]

    restoreSkillSystemMessages(msg, converted)

    expect(converted).toHaveLength(3)
    expect(converted[2]).toEqual({role: 'system', content: '# 字符串形式技能内容'})
  })

  it('失败 skill（status=error）不注入 system 消息（运行时失败分支无 injectMessage）', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill', name: 'skill', arguments: {}, status: 'error', result: {output: '', error: '未找到技能'}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc-skill', name: 'skill', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill', toolResult: '[ERROR] 未找到技能'},
    ]

    restoreSkillSystemMessages(msg, converted)

    expect(converted).toHaveLength(2)
    expect(converted.some(m => m.role === 'system')).toBe(false)
  })

  it('多个 skill 工具调用（同轮并行）恢复多条 system 消息', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill-1', name: 'skill', arguments: {}, result: {output: '技能A内容'}},
        {id: 'tc-skill-2', name: 'skill', arguments: {}, result: {output: '技能B内容'}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc-skill-1', name: 'skill', arguments: {}}, {id: 'tc-skill-2', name: 'skill', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill-1', toolResult: '技能A内容'},
      {role: 'tool', content: '', toolCallId: 'tc-skill-2', toolResult: '技能B内容'},
    ]

    restoreSkillSystemMessages(msg, converted)

    expect(converted).toHaveLength(5)
    expect(converted[3]).toEqual({role: 'system', content: '技能A内容'})
    expect(converted[4]).toEqual({role: 'system', content: '技能B内容'})
  })

  it('多 turn（多次 LLM 调用）：system 内嵌到各自 turn 的最后一个 tool 之后（逐 token 还原）', () => {
    // 运行时序列：turn0 [assistant→tool(skill)→system] → turn1 [assistant→tool(bash)]
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill', name: 'skill', arguments: {}, result: {output: '技能A内容'}},
        {id: 'tc-bash', name: 'bash', arguments: {}, result: {output: 'ok'}},
      ],
    }
    // convertFromTurnIndex 对两个 turnIndex 拆出的形状（assistant+tool 交替）
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: 'turn0', toolCalls: [{id: 'tc-skill', name: 'skill', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill', toolResult: '技能A内容'},
      {role: 'assistant', content: 'turn1', toolCalls: [{id: 'tc-bash', name: 'bash', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-bash', toolResult: 'ok'},
    ]

    restoreSkillSystemMessages(msg, converted)

    // system 必须插在 turn0 的 tool 之后、turn1 的 assistant 之前
    expect(converted).toHaveLength(5)
    expect(converted[0].role).toBe('assistant')
    expect(converted[1].role).toBe('tool')
    expect(converted[2]).toEqual({role: 'system', content: '技能A内容'})
    expect(converted[3].role).toBe('assistant')
    expect(converted[3].content).toBe('turn1')
    expect(converted[4].role).toBe('tool')
  })

  it('单 turn 多 tool（skill 后有其他工具）：system 插在所有 tool 之后（deferredMessages 语义）', () => {
    // 运行时 execute.ts：deferredMessages 在所有 tool 结果之后统一追加
    // assistant(toolCalls: [skill, bash]) → tool(skill) → tool(bash) → system(skill)
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill', name: 'skill', arguments: {}, result: {output: '技能指导'}},
        {id: 'tc-bash', name: 'bash', arguments: {}, result: {output: 'ok'}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc-skill', name: 'skill', arguments: {}}, {id: 'tc-bash', name: 'bash', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill', toolResult: '技能指导'},
      {role: 'tool', content: '', toolCallId: 'tc-bash', toolResult: 'ok'},
    ]

    restoreSkillSystemMessages(msg, converted)

    expect(converted).toHaveLength(4)
    expect(converted[1].role).toBe('tool')
    expect(converted[2].role).toBe('tool')
    expect(converted[3]).toEqual({role: 'system', content: '技能指导'})
  })

  it('assistant 无 tool 消息时不注入（无 tool 可挂靠）', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-skill', name: 'skill', arguments: {}, result: {output: '技能指导'}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: '纯文本轮', toolCalls: []},
    ]

    restoreSkillSystemMessages(msg, converted)

    // skillGuidance 有值，但 converted 中无对应 tool 消息可挂靠 → 不应凭空注入
    expect(converted).toHaveLength(1)
    expect(converted[0].role).toBe('assistant')
  })

  it('多 turn：system 不串位到无关 turn（turn1 的 skill 只插入 turn1）', () => {
    const msg: {toolCalls: HistoryToolCall[]} = {
      toolCalls: [
        {id: 'tc-bash', name: 'bash', arguments: {}, result: {output: 'ok'}},
        {id: 'tc-skill', name: 'skill', arguments: {}, result: {output: '技能B内容'}},
      ],
    }
    const converted: HistoryChatMessage[] = [
      {role: 'assistant', content: 'turn0', toolCalls: [{id: 'tc-bash', name: 'bash', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-bash', toolResult: 'ok'},
      {role: 'assistant', content: 'turn1', toolCalls: [{id: 'tc-skill', name: 'skill', arguments: {}}]},
      {role: 'tool', content: '', toolCallId: 'tc-skill', toolResult: '技能B内容'},
    ]

    restoreSkillSystemMessages(msg, converted)

    expect(converted).toHaveLength(5)
    expect(converted[0].role).toBe('assistant')
    expect(converted[1].role).toBe('tool')
    expect(converted[2].role).toBe('assistant')
    expect(converted[2].content).toBe('turn1')
    expect(converted[3].role).toBe('tool')
    expect(converted[4]).toEqual({role: 'system', content: '技能B内容'})
  })
})
