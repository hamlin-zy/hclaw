/**
 * pluginOwnership 单元测试
 *
 * 覆盖：
 * - 三类来源（agent tag / skill pluginName / command pluginName）
 *   对同一插件解析出相同 pluginName
 * - 启用判定优先级：插件禁用 > override 表值 > 文件/manifest 默认
 * - command 在插件禁用下 capabilityEnabled=false（本次行为变更）
 *
 * 测试仅使用注入的 OwnershipDeps，不触碰 PluginRegistry / SQLite。
 */
import {describe, expect, it} from 'vitest'
import {
    applyEnablement,
    extractPluginName,
    resolve,
    type CapabilityIdentity,
    type CapabilityKind,
    type OwnershipDeps,
} from '@/main/common/pluginOwnership'

/** 构造可注入的假依赖 */
function fakeDeps(
    disabled: string[] = [],
    overrides: Partial<Record<CapabilityKind, Record<string, boolean>>> = {},
): OwnershipDeps {
    const disabledSet = new Set(disabled)
    return {
        getDisabledNames: () => disabledSet,
        getOverrideEnabled: (kind, id) => overrides[kind]?.[id],
    }
}

describe('extractPluginName — 来源归一', () => {
    it('agent tag、skill、command 对同一插件给出相同 pluginName', () => {
        const sources: CapabilityIdentity[] = [
            {kind: 'agent', id: 'some-agent', tags: ['source:agents', 'plugin:demo']},
            {kind: 'skill', id: 'demo:my-skill', pluginName: 'demo'},
            {kind: 'command', id: 'demo:my-cmd', pluginName: 'demo'},
        ]

        for (const source of sources) {
            expect(extractPluginName(source)).toBe('demo')
        }
    })

    it('agent 归属仅由 tag 决定（真实插件 agent id 形如 `${name}:${prefix}`，不做 id 前缀兜底）', () => {
        expect(extractPluginName({kind: 'agent', id: 'demo:agents/x', tags: ['plugin:demo']})).toBe('demo')
        // 无 tag：即便 id 含冒号也不臆测归属
        expect(extractPluginName({kind: 'agent', id: 'demo:agents/x', tags: []})).toBeNull()
    })

    it('无归属线索的能力返回 null', () => {
        expect(extractPluginName({kind: 'agent', id: 'local-agent', tags: ['source:hclaw']})).toBeNull()
        expect(extractPluginName({kind: 'skill', id: 'local-skill'})).toBeNull()
        expect(extractPluginName({kind: 'command', id: 'local-cmd', pluginName: null})).toBeNull()
    })
})

describe('applyEnablement — 优先级', () => {
    it('插件禁用 → 强制 false（即使 override 写 enabled、文件默认 enabled）', () => {
        expect(applyEnablement('demo', true, true, true)).toEqual({
            pluginName: 'demo',
            pluginEnabled: false,
            capabilityEnabled: false,
        })
    })

    it('override 表存在 → 用表值覆盖文件默认', () => {
        expect(applyEnablement('demo', false, false, true).capabilityEnabled).toBe(false)
        expect(applyEnablement('demo', false, true, false).capabilityEnabled).toBe(true)
    })

    it('无 override → 用文件默认；无文件默认 → true', () => {
        expect(applyEnablement('demo', false, undefined, false).capabilityEnabled).toBe(false)
        expect(applyEnablement('demo', false, undefined, true).capabilityEnabled).toBe(true)
        expect(applyEnablement('demo', false, undefined, undefined).capabilityEnabled).toBe(true)
    })

    it('无插件归属（null）→ pluginEnabled=true', () => {
        const ownership = applyEnablement(null, false, undefined, true)
        expect(ownership.pluginName).toBeNull()
        expect(ownership.pluginEnabled).toBe(true)
    })
})

describe('resolve — 端到端判定', () => {
    it('插件禁用时，agent / skill / command 一律 capabilityEnabled=false', () => {
        const deps = fakeDeps(['demo'], {
            agent: {'demo:impl': true},
            skill: {'demo:sk': true},
            command: {'demo:cmd': true},
        })

        const cases: CapabilityIdentity[] = [
            {kind: 'agent', id: 'demo:impl', tags: ['plugin:demo'], fileEnabled: true},
            {kind: 'skill', id: 'demo:sk', pluginName: 'demo', fileEnabled: true},
            // command 在插件禁用下 capabilityEnabled=false（本次行为变更）
            {kind: 'command', id: 'demo:cmd', pluginName: 'demo', fileEnabled: true},
        ]

        for (const identity of cases) {
            const ownership = resolve(identity, deps)
            expect(ownership.pluginName).toBe('demo')
            expect(ownership.pluginEnabled).toBe(false)
            expect(ownership.capabilityEnabled).toBe(false)
        }
    })

    it('插件启用时，override 表值优先于文件默认', () => {
        const deps = fakeDeps([], {
            skill: {'demo:on': true, 'demo:off': false},
        })

        expect(resolve({kind: 'skill', id: 'demo:on', pluginName: 'demo', fileEnabled: false}, deps).capabilityEnabled).toBe(true)
        expect(resolve({kind: 'skill', id: 'demo:off', pluginName: 'demo', fileEnabled: true}, deps).capabilityEnabled).toBe(false)
    })

    it('插件启用且无 override 时，用文件默认', () => {
        const deps = fakeDeps([], {})
        expect(resolve({kind: 'agent', id: 'demo:a', tags: ['plugin:demo'], fileEnabled: false}, deps).capabilityEnabled).toBe(false)
        expect(resolve({kind: 'agent', id: 'demo:a', tags: ['plugin:demo'], fileEnabled: true}, deps).capabilityEnabled).toBe(true)
    })

    it('文件命令（pluginName=null）始终 pluginEnabled=true，仅受 override/文件默认影响', () => {
        const deps = fakeDeps(['demo'], {command: {'local-cmd': false}})

        const withOverride = resolve({kind: 'command', id: 'local-cmd', pluginName: null, fileEnabled: true}, deps)
        expect(withOverride.pluginName).toBeNull()
        expect(withOverride.pluginEnabled).toBe(true)
        expect(withOverride.capabilityEnabled).toBe(false)

        const withoutOverride = resolve({kind: 'command', id: 'other-cmd', pluginName: null, fileEnabled: true}, deps)
        expect(withoutOverride.pluginEnabled).toBe(true)
        expect(withoutOverride.capabilityEnabled).toBe(true)
    })
})
