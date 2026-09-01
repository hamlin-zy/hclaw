/**
 * resolveActiveModel 会话默认角色口径测试：
 * - 无 override + defaultRole=lightweight（子会话）→ 解析到 lightweight 模型（与运行层 defaultRoleForTrace 对齐）
 * - 无 override + defaultRole=primary（主会话）→ 解析到 primary 模型
 * - 子会话 lightweight 未配置（defaultRole 由 hook 降级为 primary）→ 解析到 primary
 */
import {describe, expect, it} from 'vitest'
import {resolveActiveModel} from '../../../src/renderer/lib/modelResolution'
import type {LLMProvider, ModelSchemeRole} from '@shared/types'

const providers: LLMProvider[] = [{
  id: 'ep-1',
  name: '测试服务商',
  type: 'custom',
  enabled: true,
  models: [
    {id: 'm-primary', name: '主力模型A', enabled: true},
    {id: 'm-light', name: '轻量模型B', enabled: true},
  ],
} as unknown as LLMProvider]

const primaryRole: ModelSchemeRole = {role: 'primary', enabled: true, endpointId: 'ep-1', modelId: 'm-primary'} as ModelSchemeRole
const lightRole: ModelSchemeRole = {role: 'lightweight', enabled: true, endpointId: 'ep-1', modelId: 'm-light'} as ModelSchemeRole

describe('resolveActiveModel 默认角色口径', () => {
  it('子会话（无 override，默认 lightweight）→ 显示轻量模型', () => {
    const r = resolveActiveModel({override: null, providers, defaultRole: lightRole})
    expect(r.modelId).toBe('m-light')
    expect(r.modelName).toBe('轻量模型B')
    expect(r.label).toBe('测试服务商: 轻量模型B')
  })

  it('主会话（无 override，默认 primary）→ 显示主力模型', () => {
    const r = resolveActiveModel({override: null, providers, defaultRole: primaryRole})
    expect(r.modelId).toBe('m-primary')
    expect(r.label).toBe('测试服务商: 主力模型A')
  })

  it('子会话 lightweight 未配置（hook 降级传 primary）→ 显示主力模型', () => {
    const r = resolveActiveModel({override: null, providers, defaultRole: primaryRole})
    expect(r.modelId).toBe('m-primary')
  })

  it('默认角色不可解析 → 按角色命名兜底文案', () => {
    const broken: ModelSchemeRole = {role: 'lightweight', enabled: true, endpointId: 'ep-x', modelId: 'm-x'} as ModelSchemeRole
    const r = resolveActiveModel({override: null, providers, defaultRole: broken})
    expect(r.modelId).toBeNull()
    expect(r.label).toBe('轻量模型')
  })

  it('override 优先于默认角色', () => {
    const r = resolveActiveModel({override: {endpointId: 'ep-1', modelId: 'm-primary'}, providers, defaultRole: lightRole})
    expect(r.modelId).toBe('m-primary')
  })
})
