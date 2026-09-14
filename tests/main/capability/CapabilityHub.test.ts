import {describe, expect, it} from 'vitest'

/**
 * CapabilityHub 写 seam + 订阅行为测试。
 *
 * 重构后 Hub 对外接口收敛为：只读 query 组 + replaceAll 写 seam + onChanged 订阅。
 * 变更门控：id 集合 + 条目浅签名；无变化不发信号。
 * 信号载荷仅为 { seq }（单调序号）。
 */

type Hub = import('@/main/capability/CapabilityHub').CapabilityHub
type Entry = import('@/main/capability/types').CapabilityEntry

async function newHub(): Promise<Hub> {
  const {CapabilityHub} = await import('@/main/capability/CapabilityHub')
  return new CapabilityHub()
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'a',
    name: 'A',
    description: 'desc',
    type: 'skill',
    source: 'builtin',
    enabled: true,
    searchText: '',
    ...over,
  } as Entry
}

describe('CapabilityHub.replaceAll', () => {
  it('无变化（同 id 集合 + 同浅签名）不发信号、不改 seq', async () => {
    const hub = await newHub()
    const e = entry()
    hub.replaceAll([e])

    let calls = 0
    hub.onChanged(() => { calls++ })

    // 同一条目对象再投影一次
    hub.replaceAll([e])
    // 等价但独立的新对象（searchText 已预计算）
    hub.replaceAll([entry({searchText: 'a desc'})])

    expect(calls).toBe(0)
  })

  it('有变化：seq 递增且 emit { seq }', async () => {
    const hub = await newHub()
    const seen: number[] = []
    hub.onChanged((e) => { seen.push(e.seq) })

    hub.replaceAll([entry({id: 'a'})])
    hub.replaceAll([entry({id: 'a'}), entry({id: 'b'})])

    expect(seen).toEqual([1, 2])
  })

  it('键序不同但语义相同（浅签名相等）→ 不发信号', async () => {
    const hub = await newHub()
    // 同一组值，键的插入顺序不同（JSON.stringify 会给出不同字符串，浅签名不会）
    const first = {name: 'A', description: 'desc', id: 'a', type: 'skill', source: 'builtin', enabled: true, searchText: 'a desc'} as unknown as Entry
    const second = {id: 'a', type: 'skill', name: 'A', description: 'desc', source: 'builtin', enabled: true, searchText: 'a desc'} as Entry

    hub.replaceAll([first])

    let calls = 0
    hub.onChanged(() => { calls++ })
    hub.replaceAll([second])

    expect(calls).toBe(0)
  })

  it('content 不参与浅签名（避免序列化数十 KB 正文）', async () => {
    const hub = await newHub()
    hub.replaceAll([entry({id: 'a', content: 'x'.repeat(40000)})])

    let calls = 0
    hub.onChanged(() => { calls++ })
    hub.replaceAll([entry({id: 'a', content: 'y'.repeat(40000), searchText: 'a desc'})])

    expect(calls).toBe(0)
  })

  it('allowedTools 变化参与浅签名（投影字段，须触发信号）', async () => {
    const hub = await newHub()
    hub.replaceAll([entry({id: 'a', allowedTools: ['read']})])

    let calls = 0
    hub.onChanged(() => { calls++ })
    hub.replaceAll([entry({id: 'a', allowedTools: ['read', 'write'], searchText: 'a desc'})])

    expect(calls).toBe(1)
  })

  it('仅切换 enabled（id 集合不变）也触发信号', async () => {
    const hub = await newHub()
    let calls = 0
    hub.onChanged(() => { calls++ })

    hub.replaceAll([entry({id: 'a', enabled: true})])
    calls = 0
    hub.replaceAll([entry({id: 'a', enabled: false, searchText: 'a desc'})])

    expect(calls).toBe(1)
  })

  it('订阅者能收到信号，unsubscribe 后不再收到', async () => {
    const hub = await newHub()
    const received: Array<{seq: number}> = []
    const unsub = hub.onChanged((e) => { received.push(e) })

    hub.replaceAll([entry({id: 'a'})])
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({seq: 1})

    unsub()
    hub.replaceAll([entry({id: 'b', searchText: 'a desc'})])
    expect(received).toHaveLength(1)
  })
})

describe('CapabilityHub 只读查询', () => {
  it('replaceAll 后 query/get/getPluginGroups/getStats 反映最新投影', async () => {
    const hub = await newHub()
    hub.replaceAll([
      entry({id: 'a', type: 'skill', enabled: true}),
      entry({id: 'p:1', type: 'agent', source: 'plugin', pluginName: 'p', pluginEnabled: true}),
    ])

    expect(hub.size).toBe(2)
    expect(hub.get('a')?.id).toBe('a')
    expect(hub.query({types: ['agent']}).map(e => e.id)).toEqual(['p:1'])
    expect(hub.getPluginGroups().map(g => g.name)).toEqual(['p'])
    expect(hub.getStats()).toMatchObject({total: 2, enabled: 2})
  })
})
