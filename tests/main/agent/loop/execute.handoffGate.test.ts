import {describe, it, expect} from 'vitest'
import {evaluateHandoffGate, MID_LOOP_HANDOFF_PROMPT} from '../../../../src/main/agent/loop/execute'

describe('evaluateHandoffGate（触发线 = 已解析的 token 阈值，模式无关）', () => {
  const THRESHOLD = 500_000
  it('低于阈值 → none', () => {
    expect(evaluateHandoffGate(THRESHOLD - 1, THRESHOLD, 'auto-handoff')).toBe('none')
  })
  it('恰等于阈值 → none（严格 > 判定）', () => {
    expect(evaluateHandoffGate(THRESHOLD, THRESHOLD, 'auto-handoff')).toBe('none')
  })
  it('超过 → auto-handoff 返回 inject', () => {
    expect(evaluateHandoffGate(THRESHOLD + 1, THRESHOLD, 'auto-handoff')).toBe('inject')
  })
  it('超过 → graceful-stop 返回 stop', () => {
    expect(evaluateHandoffGate(THRESHOLD + 1, THRESHOLD, 'graceful-stop')).toBe('stop')
  })
  it('thresholdTokens = 0 → 恒 none（0 = 关闭 loop 级保护，完全尊重用户配置）', () => {
    expect(evaluateHandoffGate(999_999, 0, 'auto-handoff')).toBe('none')
    expect(evaluateHandoffGate(999_999, 0, 'graceful-stop')).toBe('none')
  })
  it('thresholdTokens 取用户配置值（如 800K）生效', () => {
    expect(evaluateHandoffGate(799_999, 800_000, 'auto-handoff')).toBe('none')
    expect(evaluateHandoffGate(800_001, 800_000, 'auto-handoff')).toBe('inject')
  })
  it('中文长文本估算误差场景：边界不误伤', () => {
    expect(evaluateHandoffGate(THRESHOLD, THRESHOLD, 'auto-handoff')).toBe('none')
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
  it('含「复用清单」段要求与 toolCallId 回读指引', () => {
    expect(MID_LOOP_HANDOFF_PROMPT).toContain('复用清单')
    expect(MID_LOOP_HANDOFF_PROMPT).toContain('toolCallId')
  })
  it('复用清单约束为只写指针、禁止新建交接文件', () => {
    expect(MID_LOOP_HANDOFF_PROMPT).toContain('只写指针')
    expect(MID_LOOP_HANDOFF_PROMPT).toContain('严禁为交接新建')
  })
})
