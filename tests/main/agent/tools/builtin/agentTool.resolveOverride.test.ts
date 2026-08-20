/**
 * resolveChildConvOverride（子会话模型选择固化）单元测试
 *
 * 背景：子 Agent 指定 modelRole（lightweight/reasoning）后，ModelSelector 仍显示
 * primary（只读会话 override，而 agentTool 从不写 override）。本函数在子会话创建时
 * 解析应固化的 override：modelRole 角色 → 父会话 override 继承 → 默认 primary。
 */
import {describe, expect, it} from 'vitest'
import {resolveChildConvOverride} from '../../../../../src/main/agent/tools/builtin/agentTool'
import type {ModelOverride} from '@shared/types'

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
    {id: 'p1', name: '主力服务商', type: 'openai'},
    {id: 'p2', name: '轻量服务商', type: 'custom'},
] as any

/** 沿链内存 override 表：child → parent → grandparent */
function makeOverrideMap(entries: Record<string, ModelOverride | null>) {
    return (convId: string) => (convId in entries ? entries[convId] : null)
}

const noParentMeta = () => null as { parentConvId?: string } | null
const PARENT_CHAIN = (map: Record<string, { parentConvId?: string } | null>) =>
    (convId: string) => (convId in map ? map[convId] : null)

describe('resolveChildConvOverride', () => {
    it('modelRole=lightweight 且角色启用配置 → 固化 role 对应的服务商/模型', () => {
        const ov = resolveChildConvOverride('lightweight', SCHEME, PROVIDERS, 'conv-parent', makeOverrideMap({}), noParentMeta)
        expect(ov).toEqual({endpointId: 'p2', modelId: 'light-model-id', providerName: '轻量服务商'})
    })

    it('modelRole=primary → 固化 primary 配置', () => {
        const ov = resolveChildConvOverride('primary', SCHEME, PROVIDERS, 'conv-parent', makeOverrideMap({}), noParentMeta)
        expect(ov).toEqual({endpointId: 'p1', modelId: 'primary-model-id', providerName: '主力服务商'})
    })

    it('modelRole 角色未启用/未配置 → 落入继承逻辑（父有 override 则继承）', () => {
        const parentOv: ModelOverride = {endpointId: 'p9', modelId: 'parent-model', providerName: '父服务商'}
        const ov = resolveChildConvOverride('reasoning', SCHEME, PROVIDERS, 'conv-parent', makeOverrideMap({'conv-parent': parentOv}), noParentMeta)
        expect(ov).toEqual(parentOv)
    })

    it('modelRole 未指定 + 父会话有 override → 继承父 override', () => {
        const parentOv: ModelOverride = {endpointId: 'p9', modelId: 'parent-model', providerName: '父服务商'}
        const ov = resolveChildConvOverride(undefined, SCHEME, PROVIDERS, 'conv-parent', makeOverrideMap({'conv-parent': parentOv}), noParentMeta)
        expect(ov).toEqual(parentOv)
    })

    it('父无 override → 沿 parentConvId 链继承祖父 override', () => {
        const grandOv: ModelOverride = {endpointId: 'p8', modelId: 'grand-model', providerName: '祖服务商'}
        const ov = resolveChildConvOverride(
            undefined, SCHEME, PROVIDERS, 'conv-child',
            makeOverrideMap({'conv-grand': grandOv}),
            PARENT_CHAIN({'conv-child': {parentConvId: 'conv-parent'}, 'conv-parent': {parentConvId: 'conv-grand'}}),
        )
        expect(ov).toEqual(grandOv)
    })

    it('modelRole 非法（image_understanding / 乱写）→ 不固化该角色，走继承/默认', () => {
        // 父无 override → null（默认 primary，不固化）
        expect(resolveChildConvOverride('image_understanding' as any, SCHEME, PROVIDERS, 'conv-parent', makeOverrideMap({}), noParentMeta)).toBeNull()
        expect(resolveChildConvOverride('garbage' as any, SCHEME, PROVIDERS, 'conv-parent', makeOverrideMap({}), noParentMeta)).toBeNull()
    })

    it('全无 override 来源 → null（不固化，默认 primary）', () => {
        expect(resolveChildConvOverride(undefined, SCHEME, PROVIDERS, undefined, makeOverrideMap({}), noParentMeta)).toBeNull()
    })

    it('scheme 为 null（Worker 未同步方案）→ modelRole 不生效，走继承/默认', () => {
        const parentOv: ModelOverride = {endpointId: 'p9', modelId: 'parent-model'}
        const ov = resolveChildConvOverride('lightweight', null, PROVIDERS, 'conv-parent', makeOverrideMap({'conv-parent': parentOv}), noParentMeta)
        expect(ov).toEqual(parentOv)
    })

    it('循环父链防护：visited 集合避免死循环', () => {
        const loopMeta = PARENT_CHAIN({'conv-a': {parentConvId: 'conv-b'}, 'conv-b': {parentConvId: 'conv-a'}})
        // 不抛异常、不卡死；无 override → null
        const ov = resolveChildConvOverride(undefined, SCHEME, PROVIDERS, 'conv-a', makeOverrideMap({}), loopMeta)
        expect(ov).toBeNull()
    })
})
