import {describe, it, expect} from 'vitest'
import {buildHandoffMessage} from '../../../src/renderer/utils/handoff'

describe('buildHandoffMessage（发送前交接模板）', () => {
  it('普通输入拼接正确', () => {
    expect(buildHandoffMessage('修复登录 bug')).toBe(
      '总结当前对话历史，准备交接(session_handoff)到新会话执行：修复登录 bug',
    )
  })
  it('含换行与引号的输入不被破坏', () => {
    const input = '继续做\n"任务A" 和 \'任务B\''
    expect(buildHandoffMessage(input)).toContain('到新会话执行：继续做\n"任务A" 和 \'任务B\'')
  })
  it('空输入也拼接（不会抛错）', () => {
    expect(buildHandoffMessage('')).toBe('总结当前对话历史，准备交接(session_handoff)到新会话执行：')
  })
})
