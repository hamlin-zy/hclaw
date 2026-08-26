import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'

import {skillRegistry} from '@/main/agent/skills/registry'
import {
  collectCatalogSnapshot,
  computeDigest,
  renderCatalogContent,
  decidePublish,
  sortEntries,
} from '@/main/agent/skills/catalogInjector'
import type {CatalogEntry} from '@shared/types/message'
import type {SkillDefinition} from '@/main/agent/skills/types'

function makeSkill(id: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id,
    name: id,
    description: `desc-${id}`,
    whenToUse: `trigger-${id}`,
    enabled: true,
    content: 'body',
    ...extra,
  } as SkillDefinition
}

beforeEach(() => {
  skillRegistry.clear()
})

afterEach(() => {
  skillRegistry.clear()
  vi.restoreAllMocks()
})

describe('collectCatalogSnapshot', () => {
    it('U6a: registry 正常时 complete=true 且仅含 skills', () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, name: 'alpha', description: 'd', source: 'user'},
        ] as any)
        const snap = collectCatalogSnapshot()
        expect(snap.complete).toBe(true)
        expect(snap.entries).toHaveLength(1)
        expect(snap.entries[0].type).toBe('skill')
        vi.restoreAllMocks()
    })

    it('U6b: registry 抛错时 complete=false 且返回空数组', () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockImplementation(() => {
            throw new Error('boom')
        })
        const snap = collectCatalogSnapshot()
        expect(snap.complete).toBe(false)
        expect(snap.entries).toEqual([])
        vi.restoreAllMocks()
    })

    it('spec §4.2: userDescription 优先于 description（full 模式逐字保持）', () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            makeSkill('alpha', {userDescription: 'user desc', description: 'auto desc'}),
            makeSkill('beta', {description: 'only auto'}),
        ] as any)
        const snap = collectCatalogSnapshot()
        expect(snap.entries.find(e => e.name === 'alpha')!.description).toBe('user desc')
        expect(snap.entries.find(e => e.name === 'beta')!.description).toBe('only auto')
        vi.restoreAllMocks()
    })

    it('desc+trigger 全空条目跳过（与旧 collectEntries 行为一致）', () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            makeSkill('empty1', {description: '', whenToUse: undefined}),
            makeSkill('hasTrigger', {description: '', whenToUse: 't'}),
        ] as any)
        const snap = collectCatalogSnapshot()
        // 全空条目被跳过；仅有 trigger 的保留
        expect(snap.entries.map(e => e.name)).toEqual(['hasTrigger'])
        vi.restoreAllMocks()
    })

    it('V1 契约: 名称不含插件后缀', () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, name: 'brainstorming', description: 'd', source: 'plugin', pluginName: 'superpowers@github'},
        ] as any)
        const snap = collectCatalogSnapshot()
        expect(snap.entries[0].name).toBe('brainstorming')
        expect(snap.entries[0].name).not.toContain('(')
        vi.restoreAllMocks()
    })
})

/** 固定条目 fixture（纯函数注入用） */
function collectFixture(): CatalogEntry[] {
  return [
    {name: 'alpha', type: 'skill', description: 'do alpha things'},
  ]
}

describe('computeDigest', () => {
  it('幂等：重复调用结果一致', () => {
    const e = collectFixture()
    expect(computeDigest({mode: 'full', entries: e}))
      .toBe(computeDigest({mode: 'full', entries: e}))
  })

  it('digest 对全部语义字段敏感（trigger / type / description / name）', () => {
    const base = [{name: 'x', type: 'skill' as const, description: 'd'}]
    const d = (entries: CatalogEntry[]) => computeDigest({mode: 'full', entries})
    expect(d(base)).not.toBe(d([{...base[0], trigger: 't'}]))
    expect(d(base)).not.toBe(d([{...base[0], type: 'agent' as const}]))
    expect(d(base)).not.toBe(d([{...base[0], description: 'e'}]))
    expect(d(base)).not.toBe(d([{...base[0], name: 'y'}]))
    // 显式用例：仅 trigger 变化必须改变 digest
    const a = [{name: 'x', type: 'skill' as const, description: 'd'}]
    const b = [{name: 'x', type: 'skill' as const, description: 'd', trigger: 't'}]
    expect(d(a)).not.toBe(d(b))
  })
})

describe('renderCatalogContent', () => {
  const entries: CatalogEntry[] = [
    {name: 's1', type: 'skill', description: 'd1', trigger: 't1'},
    {name: 'c1', type: 'command', description: 'd2'},
  ]

  it('first 文案含 <system-reminder>、目录行与委派规则', () => {
    const c = renderCatalogContent(entries, 'full', 'first')
    expect(c).toContain('<system-reminder>')
    expect(c).toContain('<available_skills>')
    expect(c).toContain('- [skill] `s1`: d1')
    expect(c).toContain('Delegation rules:')
  })

  it('条目行格式：有 trigger 时带管道段，无 trigger 时省略', () => {
    const c = renderCatalogContent(entries, 'full', 'first')
    expect(c).toMatch(/- \[skill\] `s1`: d1 \| t1/)
    expect(c).toMatch(/- \[command\] `c1`: d2$/m)
    expect(c).not.toContain('`c1`: d2 |')
  })

  it('replacement 文案声明取代语义', () => {
    const c = renderCatalogContent(entries, 'full', 'replacement')
    expect(c).toContain('replaces every earlier capability list')
    expect(c).toContain('Use only names in this replacement catalog.')
  })

  it('空目录使用 empty 文案且声明不得使用早期目录', () => {
    const c = renderCatalogContent([], 'full', 'empty')
    expect(c).toContain('No skills are currently available')
    expect(c).toContain('<system-reminder>')
  })
})

describe('decidePublish 四格决策表', () => {
  const snap = (es: CatalogEntry[], complete = true): Parameters<typeof decidePublish>[0] =>
    ({entries: es, complete})
  const eA = collectFixture()
  const eB: CatalogEntry[] = [
    {name: 'alpha', type: 'skill', description: 'changed'},
  ]
  const dOf = (e: CatalogEntry[]) => computeDigest({mode: 'full', entries: e})

  it('首次发布（digest 不同 / 无已发布消息）→ publish + first 文案', () => {
    const r = decidePublish(snap(eA), 'full', undefined, false, 0)
    expect(r.decision.action).toBe('publish')
    expect(r.decision.content).toContain('The following capabilities are available')
    expect(r.decision.metadata!.sourceKind).toBe('capability-catalog')
    expect(r.decision.metadata!.catalogDigest).toBe(dOf(eA))
    expect(r.nextIncompleteStreak).toBe(0)
  })

  it('digest 相同且已有消息 → none（零操作）', () => {
    const d1 = decidePublish(snap(eA), 'full', undefined, false, 0)
    const back = decidePublish(snap(eA), 'full', d1.decision.metadata!.catalogDigest, true, 0)
    expect(back.decision.action).toBe('none')
  })

  it('digest 相同但无已发布消息（异常态）→ 重新 publish（first 文案）', () => {
    const r = decidePublish(snap(eA), 'full', dOf(eA), false, 0)
    expect(r.decision.action).toBe('publish')
  })

  it('digest 不同且有已发布消息 → replace + replacement 文案', () => {
    const d1 = decidePublish(snap(eA), 'full', undefined, false, 0)
    const r = decidePublish(snap(eB), 'full', d1.decision.metadata!.catalogDigest, true, 0)
    expect(r.decision.action).toBe('replace')
    expect(r.decision.content).toContain('replaces every earlier capability list')
    expect(r.decision.metadata!.catalogDigest).toBe(dOf(eB))
  })

  it('启停抖动回到原 digest 时命中零操作', () => {
    const d1 = decidePublish(snap(eA), 'full', undefined, false, 0)
    expect(d1.decision.action).toBe('publish')
    const off = decidePublish(snap([]), 'full', d1.decision.metadata!.catalogDigest, true, 0)
    expect(off.decision.action).toBe('replace')   // 目录变空
    const back = decidePublish(snap(eA), 'full', d1.decision.metadata!.catalogDigest, true, 0)
    expect(back.decision.action).toBe('none')     // 抖动回来：digest 相同且有已发布消息
  })

  it('字段敏感性：仅 trigger 变化触发替换', () => {
    const a: CatalogEntry[] = [{name: 'x', type: 'skill', description: 'd'}]
    const b: CatalogEntry[] = [{name: 'x', type: 'skill', description: 'd', trigger: 't'}]
    const d1 = decidePublish(snap(a), 'full', undefined, false, 0)
    const r = decidePublish(snap(b), 'full', d1.decision.metadata!.catalogDigest, true, 0)
    expect(r.decision.action).toBe('replace')
  })

  it('空目录且从未发布 → 不发消息（spec §5.2 空目录规则）', () => {
    const r = decidePublish(snap([]), 'full', undefined, false, 0)
    expect(r.decision.action).toBe('none')
  })
})
function entry(name: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {name, type: 'skill', description: '', ...overrides}
}

describe('sortEntries', () => {
  it('U4a: 同名冲突 user 胜 plugin，plugin 胜 builtin', () => {
    const sorted = sortEntries([
      entry('x', {source: 'builtin'} as any),
      entry('x', {source: 'user'} as any),
      entry('x', {source: 'plugin'} as any),
    ])
    expect(sorted.filter(e => e.name === 'x')).toHaveLength(1)
    expect((sorted[0] as any).source).toBe('user')
  })

  it('U5: source 缺失视为 rank 250（介于 plugin 与 builtin 之间）', () => {
    const sorted = sortEntries([
      entry('x', {source: undefined} as any),
      entry('x', {source: 'builtin'} as any),
    ])
    // 同名去重：rank 250 胜过 builtin(300)
    expect(sorted.filter(e => e.name === 'x')).toHaveLength(1)
    expect((sorted[0] as any).source).toBeUndefined()

    const vsPlugin = sortEntries([
      entry('x', {source: undefined} as any),
      entry('x', {source: 'plugin'} as any),
    ])
    // rank 250 败给 plugin(200)
    expect((vsPlugin[0] as any).source).toBe('plugin')
  })

  it('U4b: 不同名条目保持名称序', () => {
    const sorted = sortEntries([entry('c'), entry('a'), entry('b')])
    expect(sorted.map(e => e.name)).toEqual(['a', 'b', 'c'])
  })
})

// append
describe('dual-mode rendering & digest', () => {
  const entries = [entry('alpha', {description: 'Do A', trigger: 'when A'})]

  it('U1: names-only 输出仅名称列表，无描述/trigger 字符', () => {
    const out = renderCatalogContent(entries, 'names', 'first')
    expect(out).toContain('alpha')
    expect(out).not.toContain('Do A')
    expect(out).not.toContain('when A')
    expect(out).toContain('describe_skills')
    expect(out).toContain('list_agents')
    expect(out).not.toContain('[command]')
  })

  it('U1b: names 索引块内不含反引号/竖线等装饰字符', () => {
    const out = renderCatalogContent(entries, 'names', 'first')
    const indexBlock = out.split('<available_skills>')[1]?.split('</available_skills>')[0] ?? ''
    expect(indexBlock).not.toContain('`')
    expect(indexBlock).not.toContain('|')
  })

  it('U2: full 模式条目行与旧格式逐字一致', () => {
    const out = renderCatalogContent(entries, 'full', 'first')
    expect(out).toContain('- [skill] `alpha`: Do A | when A')
  })

  it('U3: 同一 entries 两种 mode digest 不同', () => {
    expect(computeDigest({mode: 'names', entries}))
      .not.toBe(computeDigest({mode: 'full', entries}))
  })

  it('U13: 索引名契约——真实 snapshot 渲染出的每个索引名都是 registry 合法实名（V1 回归锁）', () => {
    // 固定 mock 数据：spy 只负责喂给 registry，渲染输入必须走真实 collectCatalogSnapshot 路径
    const spyData = [
      {enabled: true, name: 'alpha', description: 'Do A', whenToUse: 'when A', source: 'plugin'},
      {enabled: true, name: 'zeta', description: 'Do Z', whenToUse: undefined, source: 'user'},
    ]
    const spy = vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue(spyData as SkillDefinition[])

    const snap = collectCatalogSnapshot()
    expect(snap.complete).toBe(true)
    const out = renderCatalogContent(snap.entries, 'names', 'first')

    const indexBlock = out.split('<available_skills>')[1]?.split('</available_skills>')[0] ?? ''
    const indexNames = indexBlock.split(',').map(s => s.trim()).filter(Boolean)
    // 与 registry 实名（mock 数据）双向比对：无幻觉名、无遗漏
    const registryNames = new Set(skillRegistry.getEnabled().map(s => s.name))
    expect(registryNames.size).toBe(spyData.length)
    expect(new Set(indexNames)).toEqual(registryNames)
    for (const name of indexNames) {
      expect(registryNames.has(name)).toBe(true)
      expect(name).not.toMatch(/[()]/) // V1：禁止插件后缀装饰
    }

    spy.mockRestore()
  })
})

const snapFor = (es: CatalogEntry[], complete = true): Parameters<typeof decidePublish>[0] =>
    ({entries: es, complete})

describe('decidePublish two-stage', () => {
    const one = [entry('alpha')]

    it('U9a: 不完整且 streak<3 → none，streak 递增，lastDigest 不变', () => {
        const r = decidePublish(snapFor([], false), 'names', 'old', true, 0)
        expect(r.decision.action).toBe('none')
        expect(r.nextIncompleteStreak).toBe(1)
    })

    it('U9b: 连续失败≥3 → 残缺数据照常决策', () => {
        const r = decidePublish(snapFor(one, false), 'names', 'old', true, 3)
        expect(r.decision.action).toBe('replace')
        expect(r.nextIncompleteStreak).toBe(4)
    })

    it('U8a: 空目录且从未发布 → 不发消息', () => {
        const r = decidePublish(snapFor([]), 'names', undefined, false, 0)
        expect(r.decision.action).toBe('none')
        expect(r.nextIncompleteStreak).toBe(0)
    })

    it('U8b: 已发布后变空 → empty replacement', () => {
        const r = decidePublish(snapFor([]), 'names', 'old', true, 0)
        expect(r.decision.action).toBe('replace')
        expect(r.decision.content).toContain('No skills are currently available')
    })

    it('U7: digest 相同且已发布 → none；相同未发布 → 重发布', () => {
        const d = computeDigest({mode: 'names', entries: one})
        expect(decidePublish(snapFor(one), 'names', d, true, 0).decision.action).toBe('none')
        expect(decidePublish(snapFor(one), 'names', d, false, 0).decision.action).toBe('publish')
    })
})
