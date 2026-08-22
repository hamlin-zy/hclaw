import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import {ToolRegistry} from '../../../../src/main/agent/tools/registry'
import {ALWAYS_ON_TOOLS} from '../../../../src/main/agent/constants'
import type {Tool} from '../../../../src/main/agent/tools/types'

function makeTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: {type: 'object', properties: {}},
    requiredPermissions: [],
    isDestructive: false,
    async execute() { return {success: true, output: 'ok'} },
  } as unknown as Tool
}

// registry 的 getToolRepo 是动态 import；按 vitest hoist 规则将 mock 置于文件顶部
// 并在 vi.hoisted 中构造 mock 对象，避免工厂引用 TDZ 变量
const {repoMock} = vi.hoisted(() => ({
  repoMock: {
    toolRepo: {
      getAllToolEnabledMap: vi.fn(),
      getEnabledToolIds: vi.fn(),
    },
  },
}))

vi.mock('../../../../src/main/repositories/sqlite/toolRepository', () => repoMock)

describe('ALWAYS_ON_TOOLS 豁免', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new ToolRegistry()
    for (const name of ['analyze_image', 'speech_to_text', 'bash']) registry.register(makeTool(name))
  })
  afterEach(() => vi.restoreAllMocks())

  it('豁免工具 DB enabled=0 → getToolDefinitions 仍含（恒启用）', async () => {
    repoMock.toolRepo.getAllToolEnabledMap.mockReturnValue(
      new Map([['analyze_image', false], ['bash', true]]),
    )
    const defs = await registry.getToolDefinitions()
    const names = defs.map(d => d.name)
    expect(names).toContain('analyze_image')
    expect(names).toContain('speech_to_text')
    expect(names).toContain('bash')
  })

  it('非豁免工具 DB enabled=0 → 不含（现状行为不变）', async () => {
    repoMock.toolRepo.getAllToolEnabledMap.mockReturnValue(new Map([['bash', false]]))
    const defs = await registry.getToolDefinitions()
    const names = defs.map(d => d.name)
    expect(names).not.toContain('bash')
    expect(names).toContain('analyze_image') // 豁免不受影响
  })

  it('getEnabledTools 同样豁免', async () => {
    repoMock.toolRepo.getEnabledToolIds.mockReturnValue(new Set(['bash']))
    const tools = await registry.getEnabledTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('analyze_image')
    expect(names).toContain('speech_to_text')
    expect(names).toContain('bash')
  })

  it('ALWAYS_ON_TOOLS 恰好两个（契约锁定）', () => {
    expect(Array.from(ALWAYS_ON_TOOLS).sort()).toEqual(['analyze_image', 'speech_to_text'])
  })
})
