import {describe, expect, it} from 'vitest'
import {allocateMcpToolNames} from '@/main/agent/mcp/discovery'

/**
 * 变异验证记录（批 3）
 * 组 3  变异：去掉规则 1 的排序（orderedServers/orderedTools 直接取原数组）→ 期望红 ✅实测红
 * 组 10 变异：去掉规则 3（chosen = candidates.find(...) ?? candidates[last]）→ 期望红 ✅实测红
 *
 * brief 缺陷记录：
 * 1) 组 3：brief 期望 r1.get('b') === 'm_3t3a_x'，实测为 'm_b_x'。
 *    b 的候选 = ['m_Same_x','m_b_x','m_3t3b_x']；m_Same_x 已被 id 更小的 a 占用 → 取候选② m_b_x。
 *    已按实测值修正（非弱化断言）。
 * 2) 组 10：brief 期望 nameMap.get('a.b') === 'm_3t3s_a_b_2'，实测为 'm_3t3s_a_b_3'。
 *    tools 按 name 升序：'a b'(0x20) < 'a.b'(0x2E) < 'a/b'(0x2F)，故 'a b' 先拿 _2，'a.b' → _3，'a/b' → _4。
 *    候选耗尽集合 {_2,_3,_4} 断言不变（规则 3 行为正确），仅按真实确定性顺序修正键值期望。
 */
describe('allocateMcpToolNames · 组 3 冲突无顺序依赖', () => {
  it('两个同名 server 交换传入顺序后分配结果不变（字典序定胜负）', () => {
    const tools = [{name: 'x'}] as any
    const a = {id: 'a', name: 'Same', tools: [{name: 'x'}] as any}
    const b = {id: 'b', name: 'Same', tools: [{name: 'x'}] as any}
    const r1 = allocateMcpToolNames([a, b], new Map())
    const r2 = allocateMcpToolNames([b, a], new Map())
    expect(r1.get('a')!.get('x')).toBe('m_Same_x')
    expect(r1.get('b')!.get('x')).toBe('m_b_x')
    expect([...r2.entries()].map(([k, v]) => [k, v.get('x')])).toEqual([...r1.entries()].map(([k, v]) => [k, v.get('x')]))
    void tools
  })
})

describe('allocateMcpToolNames · 组 10 候选耗尽兜底（规则 3）', () => {
  it('全部候选被 peer 占满 → 3 个坍缩 tool 得 _2/_3/_4', () => {
    const server = {id: 's', name: 's', tools: [{name: 'a.b'}, {name: 'a/b'}, {name: 'a b'}] as any}
    const taken = new Map([
      ['m_s_a_b', 'peer'],
      ['m_3t3s_a_b', 'peer'],
    ])
    const r = allocateMcpToolNames([server], taken)
    const nameMap = r.get('s')!
    expect([nameMap.get('a b')]).toEqual(['m_3t3s_a_b_2'])
    expect([nameMap.get('a.b')]).toEqual(['m_3t3s_a_b_3'])
    expect([nameMap.get('a/b')]).toEqual(['m_3t3s_a_b_4'])
    expect([...nameMap.values()].sort()).toEqual(['m_3t3s_a_b_2', 'm_3t3s_a_b_3', 'm_3t3s_a_b_4'])
  })
})
