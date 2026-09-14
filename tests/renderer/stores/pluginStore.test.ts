// @vitest-environment jsdom
/**
 * pluginStore 验收：插件列表/计数加载、启停乐观更新与回滚、
 * 以及「启停不再跨 store 直写 skill/agent」的边界断言（A 阶段口径）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {usePluginStore} from '../../../src/renderer/stores/pluginStore'
import {useSkillStore} from '../../../src/renderer/stores/skillStore'
import {useAgentTemplateStore} from '../../../src/renderer/stores/agentTemplateStore'

const pluginFixture = {
    name: 'demo-plugin',
    source: 'github',
    path: '/plugins/demo',
    manifest: {name: 'demo-plugin', version: '1.0.0'},
    enabled: true,
    isBuiltin: false,
}

function stubPluginApi(overrides: Record<string, any> = {}) {
    const plugin = {
        list: vi.fn(async () => [pluginFixture]),
        getRealCounts: vi.fn(async () => ({'demo-plugin': {skills: 2, agents: 1, mcps: 3}})),
        getCapabilityDetails: vi.fn(async () => ({skills: [], agents: [], mcps: []})),
        enable: vi.fn(async () => ({success: true, skills: [{name: 'injected-skill'}], agents: [{name: 'injected-agent'}]})),
        disable: vi.fn(async () => ({success: true})),
        install: vi.fn(async () => ({success: true})),
        uninstall: vi.fn(async () => ({success: true})),
        reload: vi.fn(async () => ({success: true, plugins: [pluginFixture]})),
        reset: vi.fn(async () => ({success: true})),
        getVersions: vi.fn(async () => ({tags: [], branches: [], current: '1.0.0', latest: '', loading: false})),
        syncVersions: vi.fn(async () => ({versionInfo: {tags: [], branches: [], current: '1.0.0', latest: '1.0.0', loading: false}})),
        switchVersion: vi.fn(async () => ({success: true})),
        ...overrides,
    }
    vi.stubGlobal('electronAPI', {plugin})
    return plugin
}

function resetStore() {
    usePluginStore.setState({
        plugins: [],
        realCounts: {},
        capabilityDetails: {},
        versionData: {},
        loading: true,
        error: null,
        initialized: false,
    })
}

beforeEach(() => {
    resetStore()
    useSkillStore.setState({skills: []})
    useAgentTemplateStore.setState({templates: []})
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('pluginStore', () => {
    it('loadPlugins 填充列表与真实计数，并清空 error', async () => {
        stubPluginApi()
        await usePluginStore.getState().loadPlugins()

        const state = usePluginStore.getState()
        expect(state.plugins).toHaveLength(1)
        expect(state.plugins[0].name).toBe('demo-plugin')
        expect(state.realCounts['demo-plugin']).toEqual({skills: 2, agents: 1, mcps: 3})
        expect(state.loading).toBe(false)
        expect(state.error).toBeNull()
        expect(state.initialized).toBe(true)
    })

    it('loadPlugins 失败时记录可见 error（不再静默吞掉）', async () => {
        stubPluginApi({list: vi.fn(async () => { throw new Error('boom') })})
        await usePluginStore.getState().loadPlugins()

        expect(usePluginStore.getState().error).toBe('boom')
        expect(usePluginStore.getState().loading).toBe(false)
    })

    it('togglePlugin 走乐观更新并调用 enable，且不跨 store 直写 skill/agent', async () => {
        const plugin = stubPluginApi()
        await usePluginStore.getState().loadPlugins()

        const sentinelSkills = [{id: 'keep-me'}]
        const sentinelTemplates = [{id: 'keep-me-too'}]
        useSkillStore.setState({skills: sentinelSkills as any})
        useAgentTemplateStore.setState({templates: sentinelTemplates as any})

        const result = await usePluginStore.getState().togglePlugin('demo-plugin', false)
        expect(result).toEqual({success: true})
        expect(plugin.disable).toHaveBeenCalledWith('demo-plugin')
        // 成功后按权威列表重取（list 替身仍返回 enabled:true，故以 IPC 结果为准）
        expect(plugin.list).toHaveBeenCalled()

        // A 阶段口径：能力刷新由 capability:changed 广播驱动，页面不再代写其它 store
        expect(useSkillStore.getState().skills).toBe(sentinelSkills)
        expect(useAgentTemplateStore.getState().templates).toBe(sentinelTemplates)
    })

    it('togglePlugin 失败时回滚乐观状态并返回错误', async () => {
        stubPluginApi({disable: vi.fn(async () => ({success: false, error: '禁用失败'}))})
        await usePluginStore.getState().loadPlugins()
        expect(usePluginStore.getState().plugins[0].enabled).toBe(true)

        const result = await usePluginStore.getState().togglePlugin('demo-plugin', false)

        expect(result).toEqual({success: false, error: '禁用失败'})
        expect(usePluginStore.getState().plugins[0].enabled).toBe(true)
    })

    it('loadCapabilityDetails 命中缓存后不再重复请求', async () => {
        const plugin = stubPluginApi()
        await usePluginStore.getState().loadCapabilityDetails('demo-plugin')
        await usePluginStore.getState().loadCapabilityDetails('demo-plugin')
        expect(plugin.getCapabilityDetails).toHaveBeenCalledTimes(1)
    })
})
