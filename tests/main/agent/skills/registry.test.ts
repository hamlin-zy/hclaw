/**
 * SkillRegistryImpl 单元测试
 *
 * 覆盖 register/get、conditionalSkills、路径模式匹配、find 归一化、
 * unregister/unregisterByPlugin、getEnabled 过滤、syncPluginStatus、clear、
 * getEnabledSkillContents 格式。
 *
 * 模块顶层会执行 container.register(DI_TOKENS.SkillRegistry, skillRegistry)，
 * 这里 mock 掉 common/container 避免真实容器被污染。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {SkillRegistryImpl, skillRegistry, getSkillRegistry} from '@/main/agent/skills/registry'
import type {SkillDefinition} from '@/main/agent/skills/types'

const mocks = vi.hoisted(() => ({
  containerGet: vi.fn(),
  containerRegister: vi.fn(),
}))

vi.mock('@/main/agent/common/container', () => ({
  container: {register: mocks.containerRegister, get: mocks.containerGet, replace: vi.fn(), reset: vi.fn()},
  DI_TOKENS: {SkillRegistry: 'skillRegistry'},
}))

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 's1',
    name: '测试技能',
    description: 'desc',
    content: '',
    enabled: true,
    version: '1.0.0',
    loadedAt: 0,
    ...overrides,
  }
}

describe('SkillRegistryImpl', () => {
  let registry: SkillRegistryImpl

  beforeEach(() => {
    registry = new SkillRegistryImpl()
  })

  it('register + get 按 id', () => {
    const skill = makeSkill({id: 's1', name: '技能一'})
    registry.register(skill)
    expect(registry.get('s1')).toBe(skill)
    expect(registry.get('不存在')).toBeUndefined()
  })

  it('register 带 paths → 进入 conditionalSkills；getConditionalSkills 返回', () => {
    registry.register(makeSkill({id: 'c1', paths: ['**/*.ts']}))
    registry.register(makeSkill({id: 'plain'}))
    const conditional = registry.getConditionalSkills()
    expect(conditional).toHaveLength(1)
    expect(conditional[0]!.id).toBe('c1')
  })

  it('findConditionalSkills 路径模式匹配（* 通配符转 regex）', () => {
    registry.register(makeSkill({id: 'ts', paths: ['**/*.ts']}))
    registry.register(makeSkill({id: 'js', paths: ['src/**/*.js']}))
    registry.register(makeSkill({id: 'all', paths: ['src/**']}))
    registry.register(makeSkill({id: 'plain'}))

    const matched = registry.findConditionalSkills('src/main/index.ts')
    const ids = matched.map(s => s.id).sort()
    expect(ids).toEqual(['all', 'ts'])

    const noMatch = registry.findConditionalSkills('src/main/index.js')
    expect(noMatch.map(s => s.id).sort()).toEqual(['all', 'js'])
  })

  it('find 按 id / name / 归一化（大小写 + 去 -_）', () => {
    registry.register(makeSkill({id: 's1', name: '测试技能'}))
    registry.register(makeSkill({id: 'code-review', name: '代码审查'}))

    expect(registry.find('s1')?.id).toBe('s1')
    expect(registry.find('测试技能')?.id).toBe('s1')
    expect(registry.find('CODE-REVIEW')?.id).toBe('code-review')
    expect(registry.find('code_review')?.id).toBe('code-review')
    expect(registry.find('不存在的')).toBeUndefined()
  })

  it('unregister 移除（含 conditional）', () => {
    registry.register(makeSkill({id: 'c1', paths: ['**/*.ts']}))
    registry.unregister('c1')
    expect(registry.get('c1')).toBeUndefined()
    expect(registry.getConditionalSkills()).toHaveLength(0)
  })

  it('unregisterByPlugin 返回移除数量', () => {
    registry.register(makeSkill({id: 'a1', pluginName: 'plugin-a'}))
    registry.register(makeSkill({id: 'a2', pluginName: 'plugin-a', paths: ['**/*.ts']}))
    registry.register(makeSkill({id: 'b1', pluginName: 'plugin-b'}))
    registry.register(makeSkill({id: 'n1'}))

    expect(registry.unregisterByPlugin('plugin-a')).toBe(2)
    expect(registry.get('a1')).toBeUndefined()
    expect(registry.get('a2')).toBeUndefined()
    expect(registry.getConditionalSkills()).toHaveLength(0)
    expect(registry.get('b1')).toBeDefined()
    expect(registry.get('n1')).toBeDefined()
    expect(registry.unregisterByPlugin('plugin-不存在')).toBe(0)
  })

  it('getEnabled 过滤 disabled 和 pluginEnabled=false', () => {
    registry.register(makeSkill({id: 'on'}))
    registry.register(makeSkill({id: 'off', enabled: false}))
    registry.register(makeSkill({id: 'plugin-off', pluginName: 'p', pluginEnabled: false}))
    registry.register(makeSkill({id: 'plugin-on', pluginName: 'p', pluginEnabled: true}))

    const enabled = registry.getEnabled().map(s => s.id)
    expect(enabled).toEqual(['on', 'plugin-on'])
  })

  it('syncPluginStatus 批量更新插件技能 enabled/pluginEnabled', () => {
    registry.register(makeSkill({id: 'p1', pluginName: 'plugin-x', enabled: true, pluginEnabled: true}))
    registry.register(makeSkill({id: 'p2', pluginName: 'plugin-x', enabled: true, pluginEnabled: true}))
    registry.register(makeSkill({id: 'other', pluginName: 'plugin-y', enabled: true, pluginEnabled: true}))

    registry.syncPluginStatus('plugin-x', false)
    expect(registry.get('p1')).toMatchObject({enabled: false, pluginEnabled: false})
    expect(registry.get('p2')).toMatchObject({enabled: false, pluginEnabled: false})
    expect(registry.get('other')).toMatchObject({enabled: true, pluginEnabled: true})

    registry.syncPluginStatus('plugin-x', true)
    expect(registry.get('p1')).toMatchObject({enabled: true, pluginEnabled: true})
  })

  it('clear 清空', () => {
    registry.register(makeSkill({id: 's1'}))
    registry.register(makeSkill({id: 'c1', paths: ['**/*.ts']}))
    registry.clear()
    expect(registry.getAll()).toHaveLength(0)
    expect(registry.getConditionalSkills()).toHaveLength(0)
    expect(registry.get('s1')).toBeUndefined()
  })

  it('getEnabledSkillContents 拼接格式 `### name\\n\\ncontent`', () => {
    registry.register(makeSkill({id: 'a', name: '技能甲', content: '正文甲'}))
    registry.register(makeSkill({id: 'b', name: '技能乙', content: '正文乙', enabled: false}))

    const contents = registry.getEnabledSkillContents()
    expect(contents).toHaveLength(1)
    expect(contents[0]).toBe('### 技能甲\n\n正文甲')
  })
})

describe('skillRegistry 单例', () => {
  beforeEach(() => {
    mocks.containerGet.mockReturnValue(skillRegistry)
  })

  it('默认实例与 getSkillRegistry 可用', () => {
    expect(skillRegistry).toBeInstanceOf(SkillRegistryImpl)
    expect(getSkillRegistry()).toBeInstanceOf(SkillRegistryImpl)
    expect(getSkillRegistry()).toBe(skillRegistry)
  })
})
