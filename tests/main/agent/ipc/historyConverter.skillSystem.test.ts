import {describe, expect, it} from 'vitest'
import {convertAssistantHistoryMessage} from '@/main/agent/ipc/historyConverter'

// 运行时已改为能力目录尾部注入（skillTool 不再产出 injectMessage），
// 恢复路径不再重建 role='system' 的 skill guidance 消息。
describe('恢复路径不再重建 skill 的 system 注入消息', () => {
  it('恢复含字符串 output 的 skill 工具结果时不再重建 system 消息', () => {
    const msg = {toolCalls: [{id: 'tc1', name: 'skill', arguments: {}, status: 'success',
      result: {output: 'GUIDANCE-TEXT'}}]}
    const converted = convertAssistantHistoryMessage(msg as any)
    expect(converted.some(m => m.role === 'system')).toBe(false)
  })

  it('result 为字符串形式的旧数据同样不产生 system 消息', () => {
    const msg = {toolCalls: [{id: 'tc1', name: 'skill', arguments: {}, result: '# 字符串形式技能内容'}]}
    const converted = convertAssistantHistoryMessage(msg as any)
    expect(converted.some(m => m.role === 'system')).toBe(false)
  })

  it('失败 skill（status=error）不产生 system 消息', () => {
    const msg = {toolCalls: [{id: 'tc1', name: 'skill', arguments: {}, status: 'error', result: {output: '', error: '未找到技能'}}]}
    const converted = convertAssistantHistoryMessage(msg as any)
    expect(converted.some(m => m.role === 'system')).toBe(false)
  })
})
