import {describe, expect, it} from 'vitest'
import {renderSystemPrompt as renderUtils} from '../../../../src/main/agent/utils/promptRenderer'
import {renderSystemPrompt as renderPrompts} from '../../../../src/main/agent/prompts/renderer'

describe('遗留工具列表渲染链清理', () => {
  it('utils/promptRenderer：{tools} 不再被替换（保留原文）', () => {
    const out = renderUtils('工具: {tools}', {permissionMode: 'safe', workingDir: '/tmp'})
    expect(out).toBe('工具: {tools}')
  })

  it('utils/promptRenderer：{working_dir} / {agent_type} 仍替换（回归）', () => {
    const out = renderUtils(
      '{working_dir}|{permission_mode}|{agent_type}',
      {permissionMode: 'safe', workingDir: '/tmp', agentType: 'Plan'},
    )
    expect(out).toBe('/tmp|{permission_mode}|Plan')
  })

  it('prompts/renderer：{{availableTools}} 不再被替换（保留原文）', () => {
    const out = renderPrompts('x: {{availableTools}}', {permissionMode: 'safe', workingDir: '/tmp'})
    expect(out).toBe('x: {{availableTools}}')
  })

  it('prompts/renderer：{{permissionMode}} 不再被替换（安全决策：权限模式不下发模型）', () => {
    const out = renderPrompts(
      '{{permissionMode}}|{{workingDir}}|{{agentType}}',
      {permissionMode: 'auto', workingDir: '/tmp', agentType: 'General'},
    )
    expect(out).toBe('{{permissionMode}}|/tmp|General')
  })
})
