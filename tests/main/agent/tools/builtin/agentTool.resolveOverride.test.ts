/**
 * resolveChildConvOverride（子会话模型选择固化）单元测试
 *
 * 背景：子 Agent 指定 modelRole（lightweight/reasoning）后，ModelSelector 仍显示
 * primary（只读会话 override，而 agentTool 从不写 override）。本函数在子会话创建时
 * 解析应固化的 override：显式 modelRole 角色可用（含 provider/model enabled 判定）
 * → 固化对应服务商/模型；否则 → null（不固化，运行层按默认角色链解析）。
 */
import {describe, expect, it} from 'vitest'
import {resolveChildConvOverride} from '../../../../../src/main/agent/tools/builtin/agentTool'

const SCHEME = {
    id: 'scheme-1',
    name: '测试方案',
    enabled: true,
    roles: [
        {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'primary-model-id'},
        {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'light-model-id'},
        {role: 'reasoning', enabled: false, endpointId: '', modelId: ''},
    ],
} as any

const PROVIDERS = [
    {id: 'p1', name: '主力服务商', type: 'openai', enabled: true, models: [{id: 'primary-model-id', name: '主力模型', enabled: true}]},
    {id: 'p2', name: '轻量服务商', type: 'custom', enabled: true, models: [{id: 'light-model-id', name: '轻量模型', enabled: true}]},
] as any

describe('resolveChildConvOverride', () => {
    it('modelRole=lightweight 且角色可用 → 固化 role 对应的服务商/模型', () => {
        const ov = resolveChildConvOverride('lightweight', SCHEME, PROVIDERS)
        expect(ov).toEqual({endpointId: 'p2', modelId: 'light-model-id', providerName: '轻量服务商'})
    })

    it('modelRole=primary → 固化 primary 配置', () => {
        const ov = resolveChildConvOverride('primary', SCHEME, PROVIDERS)
        expect(ov).toEqual({endpointId: 'p1', modelId: 'primary-model-id', providerName: '主力服务商'})
    })

    it('modelRole 角色未启用/未配置 → null（不固化）', () => {
        expect(resolveChildConvOverride('reasoning', SCHEME, PROVIDERS)).toBeNull()
    })

    it('modelRole 未指定 → null（不固化，运行层按默认角色链解析）', () => {
        expect(resolveChildConvOverride(undefined, SCHEME, PROVIDERS)).toBeNull()
    })

    it('modelRole 非法（image_understanding / 乱写）→ null（不固化）', () => {
        expect(resolveChildConvOverride('image_understanding' as any, SCHEME, PROVIDERS)).toBeNull()
        expect(resolveChildConvOverride('garbage' as any, SCHEME, PROVIDERS)).toBeNull()
    })

    it('scheme 为 null（Worker 未同步方案）→ modelRole 不生效，null', () => {
        expect(resolveChildConvOverride('lightweight', null, PROVIDERS)).toBeNull()
    })

    it('provider 对应服务商不存在 → null（不固化）', () => {
        const schemeBad = {...SCHEME, roles: [{role: 'lightweight', enabled: true, endpointId: 'p9', modelId: 'light-model-id'}]}
        expect(resolveChildConvOverride('lightweight', schemeBad, PROVIDERS)).toBeNull()
    })
})
