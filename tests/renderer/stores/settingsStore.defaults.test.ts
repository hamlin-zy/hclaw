import {describe, it, expect} from 'vitest'
import {DEFAULT_SETTINGS} from '../../../src/renderer/stores/settingsStore'

describe('DEFAULT_SETTINGS.agent 交接引导配置', () => {
  it('handoffThresholdRatio 默认 0.5', () => {
    expect(DEFAULT_SETTINGS.agent.handoffThresholdRatio).toBe(0.5)
  })
  it('midLoopOverflowMode 默认 auto-handoff', () => {
    expect(DEFAULT_SETTINGS.agent.midLoopOverflowMode).toBe('auto-handoff')
  })
})
