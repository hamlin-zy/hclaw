/**
 * refreshSerializedCapabilitiesInWorker 单元测试
 *
 * 覆盖运行中能力刷新语义：清空 Worker 本地 registry 后按主进程快照重建，
 * 保证主进程侧已禁用/移除的能力在 Worker 中同步消失、新启用的能力可被查到
 * （修复：运行中 agent loop 感知不到技能启停 → skillTool 报"未找到技能"）。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => {
  const makeRegistry = () => {
    const items = new Map<string, any>()
    return {
      clear: vi.fn(() => items.clear()),
      register: vi.fn((x: any) => items.set(x.id, x)),
      getAll: vi.fn(() => [...items.values()]),
      _items: items,
    }
  }
  return {
    skillRegistry: makeRegistry(),
    agentRegistry: makeRegistry(),
    trackCapability: vi.fn(),
  }
})

vi.mock('@/main/agent/skills', () => ({skillRegistry: mocks.skillRegistry}))
vi.mock('@/main/agent/agentRegistry', () => ({agentRegistry: mocks.agentRegistry}))
vi.mock('@/main/agent/powerManager', () => ({powerManager: {}}))
vi.mock('@/main/agent/common/capabilityMapper', () => ({
  capabilityMapper: {clear: vi.fn(), trackCapability: mocks.trackCapability, removePlugin: vi.fn(), getStats: vi.fn()},
}))
vi.mock('@/main/agent/logger', () => ({
  logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}))

import {refreshSerializedCapabilitiesInWorker} from '@/main/agent/capabilityManager'

describe('refreshSerializedCapabilitiesInWorker', () => {
  beforeEach(() => {
    mocks.skillRegistry._items.clear()
    mocks.agentRegistry._items.clear()
    vi.clearAllMocks()
  })

  it('替换式重建：陈旧技能被移除，新快照技能可查', async () => {
    // Worker 本地已有陈旧条目（模拟启用前加载的快照）
    mocks.skillRegistry.register({id: 'stale', name: '旧技能', enabled: true})

    await refreshSerializedCapabilitiesInWorker({
      agents: [],
      skills: [{id: 'new-skill', name: 'new-skill', description: '', content: '', enabled: true}],
      mcps: [],
    })

    expect(mocks.skillRegistry.clear).toHaveBeenCalled()
    const names = mocks.skillRegistry.getAll().map((s: any) => s.name)
    expect(names).toContain('new-skill')
    expect(names).not.toContain('旧技能')
  })

  it('agents 同步替换：旧 Agent 移除，新 Agent 注册', async () => {
    mocks.agentRegistry.register({id: 'old-agent'})

    await refreshSerializedCapabilitiesInWorker({
      agents: [{id: 'fresh-agent'} as any],
      skills: [],
      mcps: [],
    })

    const ids = mocks.agentRegistry.getAll().map((a: any) => a.id)
    expect(ids).toContain('fresh-agent')
    expect(ids).not.toContain('old-agent')
  })

  it('空快照 → registry 清空（对应"全部停用"场景）', async () => {
    mocks.skillRegistry.register({id: 'a', name: 'a', enabled: true})

    await refreshSerializedCapabilitiesInWorker({agents: [], skills: [], mcps: []})

    expect(mocks.skillRegistry.getAll()).toHaveLength(0)
  })
})
