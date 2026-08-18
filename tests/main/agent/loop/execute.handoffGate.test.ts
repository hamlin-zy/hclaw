import {describe, it, expect} from 'vitest'
import {evaluateHandoffGate, MID_LOOP_HANDOFF_PROMPT} from '../../../../src/main/agent/loop/execute'

describe('evaluateHandoffGate（触发线 = thresholdRatio，默认 0.5）', () => {
  const W = 128000
  const T = 0.5
  it('低于阈值×窗口 → none', () => {
    expect(evaluateHandoffGate(0.49 * W, W, T, 'auto-handoff')).toBe('none')
  })
  it('恰等于阈值×窗口 → none（严格 > 判定）', () => {
    expect(evaluateHandoffGate(0.5 * W, W, T, 'auto-handoff')).toBe('none')
  })
  it('超过 → auto-handoff 返回 inject', () => {
    expect(evaluateHandoffGate(0.51 * W, W, T, 'auto-handoff')).toBe('inject')
  })
  it('超过 → graceful-stop 返回 stop', () => {
    expect(evaluateHandoffGate(0.51 * W, W, T, 'graceful-stop')).toBe('stop')
  })
  it('thresholdRatio = 0 → 恒 none（0 = 关闭 loop 级保护，完全尊重用户配置）', () => {
    expect(evaluateHandoffGate(0.99 * W, W, 0, 'auto-handoff')).toBe('none')
    expect(evaluateHandoffGate(0.99 * W, W, 0, 'graceful-stop')).toBe('none')
  })
  it('thresholdRatio 取用户配置值（如 0.8）生效', () => {
    expect(evaluateHandoffGate(0.79 * W, W, 0.8, 'auto-handoff')).toBe('none')
    expect(evaluateHandoffGate(0.81 * W, W, 0.8, 'auto-handoff')).toBe('inject')
  })
  it('中文长文本估算误差场景：0.49 边界不误伤', () => {
    const chars = Math.floor(0.49 * W * 4)
    expect(evaluateHandoffGate(Math.ceil(chars / 4), W, T, 'auto-handoff')).toBe('none')
  })
})

describe('MID_LOOP_HANDOFF_PROMPT', () => {
  it('含任务进度语义', () => {
    expect(MID_LOOP_HANDOFF_PROMPT).toContain('任务进度')
  })
  it('不含发送前模板的用户输入占位（语义区分）', () => {
    expect(MID_LOOP_HANDOFF_PROMPT).not.toContain('{用户本次输入}')
  })
  it('引用 session_handoff 工具', () => {
    expect(MID_LOOP_HANDOFF_PROMPT).toContain('session_handoff')
  })
})
