// @vitest-environment jsdom
/**
 * 乐观更新回滚回归测试
 *
 * 背景：applyOptimistic 的 snapshot 是「失败时调用的回滚动作」，必须在 mutate 之前
 * 捕获旧值并真正 set 回去。历史 bug 把 snapshot 误写成 `() => get().xxx`，
 * 求值发生在 mutate 之后 → 回滚是 no-op。
 *
 * 本文件断言的是「还原」而不是「没变」：
 * - 每个用例在 persist（被 mock 的 IPC）内部抓取「乐观更新已生效」的中间态，
 *   证明 mutate 确实改动过状态（否则用例失去区分力）；
 * - 失败返回后，断言状态**引用/深值**都回到调用前的快照。
 * 若回滚退化为 no-op，中间态会残留在 store 中，断言立即失败。
 *
 * 覆盖：userCommandStore(update/delete/toggle)、agentTemplateStore(toggle/batch)、
 * skillStore(toggleSkill)、pluginStore(togglePlugin)；失败路径含
 * IPC resolve {success:false} 与 IPC reject(throw) 两种。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {useUserCommandStore, type UserCommand} from '@/renderer/stores/userCommandStore'
import {useAgentTemplateStore} from '@/renderer/stores/agentTemplateStore'
import {useSkillStore} from '@/renderer/stores/skillStore'
import {usePluginStore} from '@/renderer/stores/pluginStore'

// ─── 夹具 ──────────────────────────────────────────────

function makeCommand(over: Partial<UserCommand> = {}): UserCommand {
    return {
        id: 'cmd-1',
        name: 'alpha',
        description: 'A',
        content: 'do alpha',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        ...over,
    }
}

function makeTemplate(over: Record<string, any> = {}) {
    return {
        id: 'tpl-1',
        name: 'reviewer',
        description: 'Review agent',
        systemPrompt: 'you review',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        ...over,
    }
}

function makeSkill(over: Record<string, any> = {}) {
    return {
        id: 'sk-1',
        name: 'skill-one',
        description: 'first',
        enabled: true,
        version: '1.0.0',
        ...over,
    }
}

function makePlugin(over: Record<string, any> = {}) {
    return {
        name: 'demo-plugin',
        source: 'github',
        path: '/plugins/demo',
        manifest: {name: 'demo-plugin', version: '1.0.0'},
        enabled: true,
        isBuiltin: false,
        ...over,
    }
}

function stubApi(api: Record<string, any>) {
    vi.stubGlobal('electronAPI', api)
}

beforeEach(() => {
    useUserCommandStore.setState({commands: [], loading: false, initialized: false})
    useAgentTemplateStore.setState({templates: [], loadErrors: [], loading: false, initialized: false})
    useSkillStore.setState({skills: []})
    usePluginStore.setState({
        plugins: [],
        realCounts: {},
        capabilityDetails: {},
        versionData: {},
        loading: false,
        error: null,
        initialized: false,
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

// ─── userCommandStore ─────────────────────────────────

describe('userCommandStore 乐观回滚', () => {
    it('updateCommand：IPC resolve {success:false} 后 commands 还原到调用前（非 no-op）', async () => {
        const initial = [makeCommand()]
        const initialRef = initial
        useUserCommandStore.setState({commands: initial})

        let duringOptimistic: UserCommand[] | undefined
        stubApi({
            command: {
                update: vi.fn(async () => {
                    // 抓取乐观更新已生效的中间态——回滚必须撤销它
                    duringOptimistic = useUserCommandStore.getState().commands
                    return {success: false, error: '写入被拒绝'}
                }),
            },
        })

        const res = await useUserCommandStore.getState().updateCommand('cmd-1', {name: 'alpha-updated'})

        // 区分力：乐观写确实改动了状态
        expect(duringOptimistic?.[0].name).toBe('alpha-updated')
        // 还原：引用与深值都回到调用前
        expect(res).toEqual({success: false, error: '写入被拒绝'})
        expect(useUserCommandStore.getState().commands).toBe(initialRef)
        expect(useUserCommandStore.getState().commands).toEqual(initial)
        expect(useUserCommandStore.getState().commands[0].name).toBe('alpha')
    })

    it('deleteCommand：IPC resolve {success:false} 后被删项回归', async () => {
        const initial = [makeCommand(), makeCommand({id: 'cmd-2', name: 'beta'})]
        useUserCommandStore.setState({commands: initial})

        let duringOptimistic: UserCommand[] | undefined
        stubApi({
            command: {
                delete: vi.fn(async () => {
                    duringOptimistic = useUserCommandStore.getState().commands
                    return {success: false, error: '删除失败'}
                }),
            },
        })

        const res = await useUserCommandStore.getState().deleteCommand('cmd-1')

        expect(duringOptimistic).toHaveLength(1)
        expect(duringOptimistic?.[0].id).toBe('cmd-2')
        expect(res).toEqual({success: false, error: '删除失败'})
        expect(useUserCommandStore.getState().commands).toBe(initial)
        expect(useUserCommandStore.getState().commands.map((c) => c.id)).toEqual(['cmd-1', 'cmd-2'])
    })

    it('toggleCommand：IPC reject(throw) 后 enabled 还原', async () => {
        const initial = [makeCommand({enabled: true})]
        useUserCommandStore.setState({commands: initial})

        let duringOptimisticEnabled: boolean | undefined
        stubApi({
            command: {
                toggle: vi.fn(async () => {
                    duringOptimisticEnabled = useUserCommandStore.getState().commands[0].enabled
                    throw new Error('IPC 通道断开')
                }),
            },
        })

        const res = await useUserCommandStore.getState().toggleCommand('cmd-1', false)

        expect(duringOptimisticEnabled).toBe(false)
        expect(res).toEqual({success: false, error: 'IPC 通道断开'})
        expect(useUserCommandStore.getState().commands).toBe(initial)
        expect(useUserCommandStore.getState().commands[0].enabled).toBe(true)
    })
})

// ─── agentTemplateStore ───────────────────────────────

describe('agentTemplateStore 乐观回滚', () => {
    it('toggleTemplate：IPC reject(throw) 后 templates 还原', async () => {
        const initial = [makeTemplate({enabled: true})]
        useAgentTemplateStore.setState({templates: initial as any})

        let duringOptimisticEnabled: boolean | undefined
        stubApi({
            agentsUpdate: vi.fn(async () => {
                duringOptimisticEnabled = (useAgentTemplateStore.getState().templates[0] as any).enabled
                throw new Error('agent 写入失败')
            }),
        })

        await useAgentTemplateStore.getState().toggleTemplate('tpl-1')

        expect(duringOptimisticEnabled).toBe(false)
        expect(useAgentTemplateStore.getState().templates).toBe(initial)
        expect((useAgentTemplateStore.getState().templates[0] as any).enabled).toBe(true)
    })

    it('toggleTemplateBatch：IPC reject(throw) 后批量项全部还原', async () => {
        const initial = [
            makeTemplate({id: 'tpl-1', name: 'a', enabled: true}),
            makeTemplate({id: 'tpl-2', name: 'b', enabled: true}),
            makeTemplate({id: 'tpl-3', name: 'c', enabled: false}),
        ]
        useAgentTemplateStore.setState({templates: initial as any})

        let duringOptimistic: any[] | undefined
        stubApi({
            agentsToggleBatch: vi.fn(async () => {
                duringOptimistic = useAgentTemplateStore.getState().templates
                throw new Error('批量切换失败')
            }),
        })

        await useAgentTemplateStore.getState().toggleTemplateBatch(['tpl-1', 'tpl-2'], false)

        // 乐观写把 tpl-1/tpl-2 置为 false
        expect(duringOptimistic?.find((t) => t.id === 'tpl-1')?.enabled).toBe(false)
        expect(duringOptimistic?.find((t) => t.id === 'tpl-2')?.enabled).toBe(false)
        // 失败后整体还原
        const after = useAgentTemplateStore.getState().templates
        expect(after).toBe(initial)
        expect(after.map((t: any) => t.enabled)).toEqual([true, true, false])
    })
    it('toggleTemplate：IPC resolve {success:false}（不抛错）后 templates 也还原', async () => {
        const initial = [makeTemplate({enabled: true})]
        useAgentTemplateStore.setState({templates: initial as any})

        let duringOptimisticEnabled: boolean | undefined
        stubApi({
            agentsUpdate: vi.fn(async () => {
                duringOptimisticEnabled = (useAgentTemplateStore.getState().templates[0] as any).enabled
                return {success: false, error: 'agents:update 失败'}
            }),
        })

        await useAgentTemplateStore.getState().toggleTemplate('tpl-1')

        expect(duringOptimisticEnabled).toBe(false)
        expect(useAgentTemplateStore.getState().templates).toBe(initial)
        expect((useAgentTemplateStore.getState().templates[0] as any).enabled).toBe(true)
    })

    it('toggleTemplateBatch：IPC resolve {success:false} 后批量项全部还原', async () => {
        const initial = [
            makeTemplate({id: 'tpl-1', name: 'a', enabled: true}),
            makeTemplate({id: 'tpl-2', name: 'b', enabled: true}),
        ]
        useAgentTemplateStore.setState({templates: initial as any})

        stubApi({
            agentsToggleBatch: vi.fn(async () => ({success: false, error: '批量失败'})),
        })

        await useAgentTemplateStore.getState().toggleTemplateBatch(['tpl-1', 'tpl-2'], false)

        const after = useAgentTemplateStore.getState().templates
        expect(after).toBe(initial)
        expect(after.map((t: any) => t.enabled)).toEqual([true, true])
    })
})

// ─── skillStore ───────────────────────────────────────

describe('skillStore 乐观回滚', () => {
    it('toggleSkill：IPC resolve {success:false} 后 skills 还原', async () => {
        const initial = [makeSkill({enabled: true})]
        useSkillStore.setState({skills: initial as any})

        let duringOptimisticEnabled: boolean | undefined
        stubApi({
            skillToggle: vi.fn(async () => {
                duringOptimisticEnabled = (useSkillStore.getState().skills[0] as any).enabled
                return {success: false, error: '切换技能状态失败'}
            }),
        })

        const res = await useSkillStore.getState().toggleSkill('sk-1')

        expect(duringOptimisticEnabled).toBe(false)
        expect(res).toEqual({success: false, error: '切换技能状态失败'})
        expect(useSkillStore.getState().skills).toBe(initial)
        expect((useSkillStore.getState().skills[0] as any).enabled).toBe(true)
    })
})

// ─── pluginStore ──────────────────────────────────────

describe('pluginStore 乐观回滚', () => {
    it('togglePlugin：IPC resolve {success:false} 后 plugins 还原', async () => {
        const initial = [makePlugin({enabled: true})]
        usePluginStore.setState({plugins: initial as any})

        let duringOptimisticEnabled: boolean | undefined
        stubApi({
            plugin: {
                disable: vi.fn(async () => {
                    duringOptimisticEnabled = (usePluginStore.getState().plugins[0] as any).enabled
                    return {success: false, error: '禁用插件失败'}
                }),
            },
        })

        const res = await usePluginStore.getState().togglePlugin('demo-plugin', false)

        expect(duringOptimisticEnabled).toBe(false)
        expect(res).toEqual({success: false, error: '禁用插件失败'})
        expect(usePluginStore.getState().plugins).toBe(initial)
        expect((usePluginStore.getState().plugins[0] as any).enabled).toBe(true)
    })
})
