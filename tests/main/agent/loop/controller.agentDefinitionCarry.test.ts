import {describe, expect, it, beforeAll, afterAll} from 'vitest'
import {carryForwardCommandId} from '../../../../src/main/agent/loop/controller'
import {resolveAgentDefinitionForTurn} from '../../../../src/main/agent/agentTemplateConverter'
import {agentRegistry} from '../../../../src/main/agent/agentRegistry'

const TEST_AGENT = {
    id: 'test-carry-agent',
    name: 'test-carry-agent',
    description: 'test',
    systemPrompt: 'test prompt',
    enabled: true,
}

beforeAll(() => {
    agentRegistry.register(TEST_AGENT as any)
})

afterAll(() => {
    agentRegistry.unregister(TEST_AGENT.id)
})

/**
 * R3：命令轮 agentDefinition 跨轮一致性（KV cache tools 段修复）
 *
 * 根因：agent: 命令轮注入 agentDefinition → filterToolsForAgent 收窄工具集
 * （全局黑名单移除 skill 等）；后续普通轮无 commandId → 回退 General 全量工具
 * → tools 数组与前缀不一致 → prompt cache 在 tools 段断裂，cached_tokens 归零。
 *
 * 修复：controller 将 commandId 写入缓存载荷并跨轮携带；execution.ts 无新命令时
 * 从缓存恢复 agentDefinition，使 tools 与命令轮逐字节一致。
 */
describe('carryForwardCommandId（缓存载荷 commandId 跨轮携带）', () => {
  it('本轮有新命令 → 用新 commandId', () => {
    expect(carryForwardCommandId({commandId: 'agent:new'}, {commandId: 'agent:old'})).toBe('agent:new')
  })

  it('本轮无命令 → 沿用缓存中的 commandId', () => {
    expect(carryForwardCommandId(null, {commandId: 'agent:old'})).toBe('agent:old')
  })

  it('本轮无命令且缓存无 commandId（旧格式载荷）→ null', () => {
    expect(carryForwardCommandId(null, {})).toBeNull()
  })

  it('本轮无命令且无缓存 → null', () => {
    expect(carryForwardCommandId(null, null)).toBeNull()
  })
})

describe('resolveAgentDefinitionForTurn（次轮 agentDefinition 恢复）', () => {
  it('本轮有 agent: 命令 → 直接解析，不读缓存', () => {
    const def = resolveAgentDefinitionForTurn('agent:test-carry-agent', null)
    expect(def).toBeDefined()
    expect(def!.agentType).toBe('test-carry-agent')
  })

  it('本轮无命令 + 缓存载荷含 agent: commandId → 从缓存恢复', () => {
    const cached = JSON.stringify({core: 'prompt', commandTemplate: '', commandId: 'agent:test-carry-agent'})
    const def = resolveAgentDefinitionForTurn(undefined, cached)
    expect(def).toBeDefined()
    expect(def!.agentType).toBe('test-carry-agent')
  })

  it('本轮无命令 + 缓存无 commandId（旧格式）→ undefined（回退 General）', () => {
    expect(resolveAgentDefinitionForTurn(undefined, JSON.stringify({core: 'x'}))).toBeUndefined()
  })

  it('缓存为旧格式纯字符串（非 JSON）→ undefined 不抛错', () => {
    expect(resolveAgentDefinitionForTurn(undefined, 'plain old prompt')).toBeUndefined()
  })

  it('缓存 commandId 非 agent: 前缀 → undefined', () => {
    const cached = JSON.stringify({core: 'x', commandId: 'skill:foo'})
    expect(resolveAgentDefinitionForTurn(undefined, cached)).toBeUndefined()
  })

  it('缓存为 null → undefined', () => {
    expect(resolveAgentDefinitionForTurn(undefined, null)).toBeUndefined()
  })
})
