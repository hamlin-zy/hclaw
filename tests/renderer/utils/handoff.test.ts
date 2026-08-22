import {describe, it, expect} from 'vitest'
import {buildHandoffMessage} from '../../../src/renderer/utils/handoff'

describe('buildHandoffMessage（发送前交接模板）', () => {
  it('普通输入拼接正确', () => {
    const result = buildHandoffMessage('修复登录 bug')
    expect(result).toContain('总结当前对话历史，准备交接(session_handoff)到新会话执行：修复登录 bug')
    expect(result).toContain('【重要】若希望新会话自动启动特定技能/代理')
    expect(result).toContain('capability 参数')
  })
  it('含换行与引号的输入不被破坏', () => {
    const input = '继续做\n"任务A" 和 \'任务B\''
    const result = buildHandoffMessage(input)
    expect(result).toContain('到新会话执行：继续做\n"任务A" 和 \'任务B\'')
    expect(result).toContain('【重要】若希望新会话自动启动特定技能/代理')
  })
  it('空输入也拼接（不会抛错）', () => {
    const result = buildHandoffMessage('')
    expect(result).toContain('总结当前对话历史，准备交接(session_handoff)到新会话执行：')
    expect(result).toContain('【重要】若希望新会话自动启动特定技能/代理')
  })
})
