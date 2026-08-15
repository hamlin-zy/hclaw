/**
 * AgentRegistry 单元测试
 *
 * 覆盖 register/get/find、getAll、getEnabled 过滤、unregister、
 * unregisterByPlugin、syncPluginStatus、clear 以及插件 Agent 的来源区分。
 *
 * agentRegistry 为纯内存注册表，无文件系统 / SQLite 依赖，直接测试。
 * 每个用例通过 clear() 复位，保证相互隔离。
 */
import {beforeEach, describe, expect, it} from 'vitest'
import {agentRegistry} from '@/main/agent/agentRegistry'
import type {AgentTemplate} from '@shared/types'

function makeAgent(overrides: Partial<AgentTemplate>): AgentTemplate {
    return {
        id: 'agent-default',
        name: '默认 Agent',
        description: '默认描述',
        systemPrompt: 'system prompt',
        enabled: true,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

describe('agentRegistry — 注册与查询', () => {
    beforeEach(() => {
        agentRegistry.clear()
    })

    it('register + get 按 id 查询', () => {
        const agent = makeAgent({id: 'impl', name: 'Implementer'})
        agentRegistry.register(agent)

        expect(agentRegistry.get('impl')).toBe(agent)
    })

    it('get 未注册 id → undefined', () => {
        agentRegistry.register(makeAgent({id: 'impl'}))

        expect(agentRegistry.get('impl-unknown')).toBeUndefined()
        expect(agentRegistry.get('')).toBeUndefined()
    })

    it('getAll 列出全部注册 Agent', () => {
        agentRegistry.register(makeAgent({id: 'a', name: 'Agent A'}))
        agentRegistry.register(makeAgent({id: 'b', name: 'Agent B'}))
        agentRegistry.register(makeAgent({id: 'c', name: 'Agent C'}))

        expect(agentRegistry.getAll().map(a => a.id).sort()).toEqual(['a', 'b', 'c'])
    })

    it('register 重复 id → 覆盖旧定义（Map.set 语义）', () => {
        agentRegistry.register(makeAgent({id: 'impl', name: '旧名称', description: '旧描述'}))
        agentRegistry.register(makeAgent({id: 'impl', name: '新名称', description: '新描述'}))

        expect(agentRegistry.getAll()).toHaveLength(1)
        const agent = agentRegistry.get('impl')
        expect(agent!.name).toBe('新名称')
        expect(agent!.description).toBe('新描述')
    })

    it('unregister 移除指定 Agent', () => {
        agentRegistry.register(makeAgent({id: 'a'}))
        agentRegistry.register(makeAgent({id: 'b'}))

        agentRegistry.unregister('a')

        expect(agentRegistry.get('a')).toBeUndefined()
        expect(agentRegistry.get('b')).toBeDefined()
        expect(agentRegistry.getAll()).toHaveLength(1)
    })

    it('unregister 不存在的 id 不抛错', () => {
        expect(() => agentRegistry.unregister('not-exist')).not.toThrow()
    })

    it('clear 清空所有 Agent', () => {
        agentRegistry.register(makeAgent({id: 'a'}))
        agentRegistry.register(makeAgent({id: 'b'}))

        agentRegistry.clear()

        expect(agentRegistry.getAll()).toHaveLength(0)
        expect(agentRegistry.get('a')).toBeUndefined()
    })
})

describe('agentRegistry — find 查找', () => {
    beforeEach(() => {
        agentRegistry.clear()
    })

    it('find 精确匹配 id', () => {
        agentRegistry.register(makeAgent({id: 'code-review', name: '代码审查'}))

        expect(agentRegistry.find('code-review')?.id).toBe('code-review')
    })

    it('find 精确匹配 name', () => {
        agentRegistry.register(makeAgent({id: 'code-review', name: '代码审查'}))

        expect(agentRegistry.find('代码审查')?.id).toBe('code-review')
    })

    it('find 模糊匹配忽略大小写与 -/_ 分隔符', () => {
        agentRegistry.register(makeAgent({id: 'code-review', name: '代码审查'}))
        agentRegistry.register(makeAgent({id: 'explorer', name: '探索-Agent'}))

        // id 侧归一化
        expect(agentRegistry.find('CODE-REVIEW')?.id).toBe('code-review')
        expect(agentRegistry.find('code_review')?.id).toBe('code-review')
        expect(agentRegistry.find('CodeReview')?.id).toBe('code-review')
        // name 侧归一化
        expect(agentRegistry.find('探索-Agent')?.id).toBe('explorer')
        expect(agentRegistry.find('探索_AGENT')?.id).toBe('explorer')
    })

    it('find 未注册 Agent → undefined', () => {
        agentRegistry.register(makeAgent({id: 'impl'}))

        expect(agentRegistry.find('不存在')).toBeUndefined()
        expect(agentRegistry.find('')).toBeUndefined()
    })
})

describe('agentRegistry — 启用状态', () => {
    beforeEach(() => {
        agentRegistry.clear()
    })

    it('getEnabled 仅返回 enabled=true 的 Agent', () => {
        agentRegistry.register(makeAgent({id: 'on-1', enabled: true}))
        agentRegistry.register(makeAgent({id: 'off-1', enabled: false}))
        agentRegistry.register(makeAgent({id: 'on-2', enabled: true}))

        expect(agentRegistry.getEnabled().map(a => a.id).sort()).toEqual(['on-1', 'on-2'])
    })
})

describe('agentRegistry — 插件 Agent 来源区分', () => {
    beforeEach(() => {
        agentRegistry.clear()
    })

    it('插件 Agent 通过 plugin: 前缀标签区分来源', () => {
        agentRegistry.register(makeAgent({
            id: 'plugin:demo:demo-agent',
            name: 'Demo Agent',
            tags: ['plugin:demo'],
        }))
        agentRegistry.register(makeAgent({id: 'local-agent', name: '本地 Agent', tags: []}))

        const pluginAgents = agentRegistry.getAll()
            .filter(a => a.tags?.some(t => t.startsWith('plugin:')))
        expect(pluginAgents.map(a => a.id)).toEqual(['plugin:demo:demo-agent'])
        expect(agentRegistry.get('local-agent')!.tags).toEqual([])
    })

    it('unregisterByPlugin 通过 id 前缀与标签移除插件 Agent，返回移除数量', () => {
        agentRegistry.register(makeAgent({id: 'plugin:alpha:agent-1', tags: ['plugin:alpha']}))
        agentRegistry.register(makeAgent({id: 'plugin:alpha:agent-2', tags: ['plugin:alpha']}))
        agentRegistry.register(makeAgent({id: 'plugin:beta:agent-3', tags: ['plugin:beta']}))
        agentRegistry.register(makeAgent({id: 'local-agent', tags: []}))

        expect(agentRegistry.unregisterByPlugin('alpha')).toBe(2)

        expect(agentRegistry.get('plugin:alpha:agent-1')).toBeUndefined()
        expect(agentRegistry.get('plugin:alpha:agent-2')).toBeUndefined()
        expect(agentRegistry.get('plugin:beta:agent-3')).toBeDefined()
        expect(agentRegistry.get('local-agent')).toBeDefined()
    })

    it('unregisterByPlugin 同时匹配仅带 plugin: 标签的 Agent', () => {
        // id 不含 plugin: 前缀，但带 plugin:gamma 标签
        agentRegistry.register(makeAgent({id: 'gamma-special', tags: ['plugin:gamma']}))
        agentRegistry.register(makeAgent({id: 'local-agent', tags: []}))

        expect(agentRegistry.unregisterByPlugin('gamma')).toBe(1)
        expect(agentRegistry.get('gamma-special')).toBeUndefined()
        expect(agentRegistry.get('local-agent')).toBeDefined()
    })

    it('unregisterByPlugin 不存在的插件返回 0', () => {
        agentRegistry.register(makeAgent({id: 'local-agent', tags: []}))

        expect(agentRegistry.unregisterByPlugin('not-installed')).toBe(0)
    })

    it('syncPluginStatus 同步插件 Agent 的启用状态，本地 Agent 不受影响', () => {
        agentRegistry.register(makeAgent({id: 'plugin:alpha:agent-1', enabled: true, tags: ['plugin:alpha']}))
        agentRegistry.register(makeAgent({id: 'local-agent', enabled: true, tags: []}))

        agentRegistry.syncPluginStatus('alpha', false)

        expect(agentRegistry.get('plugin:alpha:agent-1')!.enabled).toBe(false)
        expect(agentRegistry.get('local-agent')!.enabled).toBe(true)

        agentRegistry.syncPluginStatus('alpha', true)
        expect(agentRegistry.get('plugin:alpha:agent-1')!.enabled).toBe(true)
    })
})

describe('agentRegistry — 单例', () => {
    it('导出的 agentRegistry 为全局单例实例', () => {
        expect(agentRegistry).toBeDefined()
        expect(typeof agentRegistry.register).toBe('function')
        expect(typeof agentRegistry.find).toBe('function')
        expect(typeof agentRegistry.getEnabled).toBe('function')
    })
})
