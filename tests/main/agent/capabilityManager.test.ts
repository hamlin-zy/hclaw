/**
 * CapabilityManager 单元测试
 *
 * 覆盖能力索引构建（Agent + Skill + MCP 汇总）、查询特定能力、
 * 启用/禁用状态、分类统计以及插件→能力映射。
 *
 * mock 策略：capabilityManager 依赖 powerManager 单例（内部依赖文件系统扫描 /
 * 插件注册表 / MCP 服务，重型依赖），因此整体 mock powerManager 模块，返回
 * 可控的 EnabledPower；capabilityMapper 与 serializeCapabilities 使用真实实现，
 * 验证端到端的映射与序列化行为。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
    initialize: vi.fn(),
    refresh: vi.fn(),
    getAllEnabledPower: vi.fn(),
}))

vi.mock('@/main/agent/powerManager', () => ({
    powerManager: {
        initialize: mocks.initialize,
        refresh: mocks.refresh,
        getAllEnabledPower: mocks.getAllEnabledPower,
        getAllEanbelPower: mocks.getAllEnabledPower,
    },
}))

import {capabilityManager} from '@/main/agent/capabilityManager'
import {capabilityMapper} from '@/main/common/capabilityMapper'
import type {EnabledPower} from '@/main/agent/powerManager'
import type {AgentTemplate} from '@shared/types'
import type {SkillDefinition} from '@/main/agent/skills/types'
import type {MCPServerState} from '@/main/agent/mcp/types'

function makeAgent(overrides: Partial<AgentTemplate>): AgentTemplate {
    return {
        id: 'agent-default',
        name: '默认 Agent',
        description: 'desc',
        systemPrompt: 'prompt',
        enabled: true,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
    return {
        id: 'skill-default',
        name: '默认技能',
        description: 'desc',
        content: '',
        enabled: true,
        version: '1.0.0',
        loadedAt: 0,
        ...overrides,
    }
}

function makeMcp(overrides: Partial<MCPServerState> = {}): MCPServerState {
    return {
        config: {
            id: 'mcp_demo_server',
            name: 'Demo Server',
            type: 'mcp',
            command: '',
            args: [],
            env: {},
            enabled: true,
        },
        status: 'connected',
        tools: [
            {name: 'demo_tool', description: 'Demo tool', inputSchema: {type: 'object'} as Record<string, unknown>},
        ],
        ...overrides,
    } as MCPServerState
}

/** 构造一个包含 Agent / Skill / MCP 的完整能力集 */
function buildPower(): EnabledPower {
    return {
        agents: [
            makeAgent({id: 'impl', name: 'Implementer'}),
            makeAgent({id: 'reviewer', name: 'Reviewer', enabled: false}),
        ],
        skills: [
            makeSkill({id: 'skill-a', name: '技能 A'}),
            makeSkill({id: 'skill-b', name: '技能 B', enabled: false}),
        ],
        mcps: [makeMcp()],
    }
}

describe('capabilityManager — 能力索引构建', () => {
    beforeEach(() => {
        mocks.initialize.mockReset()
        mocks.refresh.mockReset()
        mocks.getAllEnabledPower.mockReset()
        capabilityMapper.clear()
    })

    it('initialize 委托给 powerManager.initialize 并透传插件启用映射', async () => {
        mocks.initialize.mockResolvedValue(undefined)

        const pluginEnabledMap = {demo: true, other: false}
        await capabilityManager.initialize(pluginEnabledMap)

        expect(mocks.initialize).toHaveBeenCalledTimes(1)
        expect(mocks.initialize).toHaveBeenCalledWith(pluginEnabledMap)
    })

    it('refresh 委托给 powerManager.refresh', async () => {
        mocks.refresh.mockResolvedValue(undefined)

        await capabilityManager.refresh()

        expect(mocks.refresh).toHaveBeenCalledTimes(1)
    })

    it('getEnabledPower 汇总 Agent + Skill + MCP', async () => {
        const power = buildPower()
        mocks.getAllEnabledPower.mockResolvedValue(power)

        const result = await capabilityManager.getEnabledPower()

        expect(result).toBe(power)
        expect(result.agents).toHaveLength(2)
        expect(result.skills).toHaveLength(2)
        expect(result.mcps).toHaveLength(1)
        // 能力索引三类来源齐备
        expect(result.agents.some(a => a.id === 'impl')).toBe(true)
        expect(result.skills.some(s => s.id === 'skill-a')).toBe(true)
        expect(result.mcps.some(m => (m as any).config?.id === 'mcp_demo_server')).toBe(true)
    })
})

describe('capabilityManager — 序列化', () => {
    beforeEach(() => {
        mocks.getAllEnabledPower.mockReset()
        capabilityMapper.clear()
    })

    it('serializeForWorker 序列化全部能力（Agent / Skill / MCP）', async () => {
        mocks.getAllEnabledPower.mockResolvedValue(buildPower())

        const serialized = await capabilityManager.serializeForWorker()

        expect(serialized.agents.map(a => a.id).sort()).toEqual(['impl', 'reviewer'])
        expect(serialized.skills.map(s => s.id).sort()).toEqual(['skill-a', 'skill-b'])
        expect(serialized.mcps.map(m => m.id)).toEqual(['mcp_demo_server'])
        expect(serialized.mcps[0]!.tools).toHaveLength(1)
        expect(serialized.mcps[0]!.tools[0]!.name).toBe('demo_tool')
    })

    it('serializeForWorker 保留技能的 pluginName 与 content 字段', async () => {
        mocks.getAllEnabledPower.mockResolvedValue({
            agents: [],
            skills: [
                makeSkill({id: 'plugin-skill', pluginName: 'demo', content: '正文'}),
                makeSkill({id: 'local-skill', content: '本地正文'}),
            ],
            mcps: [],
        })

        const serialized = await capabilityManager.serializeForWorker()

        const pluginSkill = serialized.skills.find(s => s.id === 'plugin-skill')
        expect(pluginSkill!.pluginName).toBe('demo')
        expect(pluginSkill!.content).toBe('正文')
        const localSkill = serialized.skills.find(s => s.id === 'local-skill')
        expect(localSkill!.pluginName).toBeUndefined()
    })
})

describe('capabilityManager — 启用/禁用状态', () => {
    beforeEach(() => {
        mocks.getAllEnabledPower.mockReset()
        capabilityMapper.clear()
    })

    it('serializeForWorker 透传 enabled 字段，disabled 能力保留在结果中', async () => {
        mocks.getAllEnabledPower.mockResolvedValue(buildPower())

        const serialized = await capabilityManager.serializeForWorker()

        expect(serialized.agents.find(a => a.id === 'impl')!.enabled).toBe(true)
        expect(serialized.agents.find(a => a.id === 'reviewer')!.enabled).toBe(false)
        expect(serialized.skills.find(s => s.id === 'skill-a')!.enabled).toBe(true)
        expect(serialized.skills.find(s => s.id === 'skill-b')!.enabled).toBe(false)
    })
})

describe('capabilityManager — 分类统计与插件映射', () => {
    beforeEach(() => {
        capabilityMapper.clear()
    })

    it('getMappingStats 汇总插件与能力数量', () => {
        capabilityMapper.trackCapability('plugin-a', 'cap-1')
        capabilityMapper.trackCapability('plugin-a', 'cap-2')
        capabilityMapper.trackCapability('plugin-b', 'cap-3')

        expect(capabilityManager.getMappingStats()).toEqual({pluginCount: 2, capabilityCount: 3})

        capabilityMapper.trackCapability('plugin-a', 'cap-1')
        expect(capabilityManager.getMappingStats()).toEqual({pluginCount: 2, capabilityCount: 3})
    })

    it('getCapabilitiesByPlugin 返回插件的能力列表', () => {
        capabilityMapper.trackCapability('plugin-a', 'agent-1')
        capabilityMapper.trackCapability('plugin-a', 'skill-1')
        capabilityMapper.trackCapability('plugin-b', 'mcp-1')

        expect(capabilityManager.getCapabilitiesByPlugin('plugin-a').sort()).toEqual(['agent-1', 'skill-1'])
        expect(capabilityManager.getCapabilitiesByPlugin('plugin-b')).toEqual(['mcp-1'])
        expect(capabilityManager.getCapabilitiesByPlugin('not-exist')).toEqual([])
    })

    it('getPluginByCapability 查询能力所属插件', () => {
        capabilityMapper.trackCapability('plugin-a', 'agent-1')
        capabilityMapper.trackCapability('plugin-b', 'skill-1')

        expect(capabilityManager.getPluginByCapability('agent-1')).toBe('plugin-a')
        expect(capabilityManager.getPluginByCapability('skill-1')).toBe('plugin-b')
        expect(capabilityManager.getPluginByCapability('not-exist')).toBeUndefined()
    })

    it('本地能力（无插件）不进入映射统计', () => {
        capabilityMapper.trackCapability(undefined, 'local-agent')
        capabilityMapper.trackCapability('', 'local-skill')

        expect(capabilityManager.getMappingStats()).toEqual({pluginCount: 0, capabilityCount: 0})
        expect(capabilityManager.getPluginByCapability('local-agent')).toBeUndefined()
    })
})
