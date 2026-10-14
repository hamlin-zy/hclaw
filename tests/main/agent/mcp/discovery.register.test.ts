import {beforeEach, describe, expect, it} from 'vitest'
import {registerMCPTools, registerAllMcpTools, unregisterMCPTools, getAllMcpToolMeta} from '@/main/agent/mcp/discovery'
import {toMcpToolDefinition} from '@/main/agent/mcp/sdkAdapter'
import {toolRegistry} from '@/main/agent/tools/registry'

/**
 * 变异验证记录（批 3 · 真红绿）
 * 组 4  改动前：连注册 3 次同名 → ✅实测红，收到 ['m_A_x','m_3t3s_x']（第 2 次起漂移到 shortId 名）
 *      变异（双点，单点无效）：同时去掉 registerMCPTools 步骤 1 的安全注销 **与** 规则 4（taken 剔除自身旧名）→ ✅实测红，收到 ['m_A_x','m_s_x','m_3t3s_x']
 *      单点变异（只去掉步骤 1）→ ✅实测仍绿（组 4 恒过），印证需双点
 * 组 8  改动前：registerMCPTools('s',[...],undefined,'A') 后再 ('s',[...],undefined,'B') → ✅实测红（mcpToolMeta 项数 2，期望 1）
 *      变异：去掉步骤 1 的安全注销 → ✅实测红（expected 2 to be 1）
 * --- Task 7 · 组 9 批量入口 registerAllMcpTools ---
 * 变异 1：去掉「逐 server 先注销自身旧名」（步骤 1）→ ✅实测红 组 9②（AssertionError: expected 3 to be 2，孤儿残留）
 * 变异 2：规则 0 改为「保留末次出现」→ ✅实测红 组 9①（expected [ 'm_A_y' ] to deeply equal [ 'm_A_x' ]）
 * 变异 3：去掉 userDescription 透传 → ✅实测红 组 9③（expected false to be true，description 缺「场景说明:」前缀）
 * 三条均已改回；改回后组 4/8/9 全绿（5/5）。
 * --- Task 9 · 组 11 override 承载 ---
 * 改动前：registerMCPTools 无第 5 参 → ✅实测红（AssertionError: expected undefined to deeply equal
 *      { unknownPolicy: 'allow', readOnlyTools: ['frobnicate'] }，meta.override 为 undefined）
 * 变异：createMCPToolProxy 去掉空 override 判空（改为 override 恒写键）→ ✅实测红 组 11②
 *      （AssertionError: expected true to be false，'override' in meta 恒真）
 * 已还原；还原后组 4/8/9/10/11 全绿（8/8）。
 */
const tools = [{name: 'x', description: 'x', inputSchema: {type: 'object'}}] as any

beforeEach(() => {
  unregisterMCPTools('s')
})

describe('组 4 命名稳定性', () => {
  it('同一 (serverId, toolName) 连注册 3 次同名（即使调用方不先注销）', () => {
    for (let i = 0; i < 3; i++) registerMCPTools('s', tools, undefined, 'A')
    const names = getAllMcpToolMeta().filter((m) => m.serverId === 's').map((m) => m.proxyName)
    expect(names).toEqual(['m_A_x'])
  })
})

describe('组 8 孤儿注册项', () => {
  it('二次注册不同 serverName → 该 server 的注册项数恒 == tools.length', () => {
    registerMCPTools('s', tools, undefined, 'A')
    registerMCPTools('s', tools, undefined, 'B')
    const registered = toolRegistry.getAll().filter((t) => t.name.startsWith('m_') && t.name.endsWith('_x'))
    const mine = getAllMcpToolMeta().filter((m) => m.serverId === 's')
    expect(mine.length).toBe(tools.length)
    expect(mine.map((m) => m.proxyName)).toEqual(['m_B_x'])
    expect(registered.map((t) => t.name).sort()).toEqual(['m_B_x'])
  })
})

describe('组 9 批量入口 registerAllMcpTools', () => {
  const schema = {type: 'object'} as any
  it('① 重复 id 去重（保留首次）', () => {
    const r = registerAllMcpTools([
      {id: 's', name: 'A', tools: [{name: 'x', inputSchema: schema}] as any},
      {id: 's', name: 'A', tools: [{name: 'y', inputSchema: schema}] as any},
    ])
    expect(r).toBe(1)
    expect(getAllMcpToolMeta().map((m) => m.proxyName)).toEqual(['m_A_x'])
  })

  it('② 逐 server 先注销自身旧名（不翻倍、无孤儿）', () => {
    registerAllMcpTools([{id: 's', name: 'A', tools: [{name: 'x', inputSchema: schema}] as any}])
    registerAllMcpTools([{id: 's', name: 'B', tools: [{name: 'x', inputSchema: schema}, {name: 'y', inputSchema: schema}] as any}])
    expect(getAllMcpToolMeta().filter((m) => m.serverId === 's').length).toBe(2)
  })

  it('③ userDescription 透传（proxy.description 前缀「场景说明:」）', () => {
    registerAllMcpTools([{id: 's', name: 'A', userDescription: '查知识库', tools: [{name: 'x', description: 'd', inputSchema: schema}] as any}])
    const desc = toolRegistry.getAll().find((t) => t.name === 'm_A_x')!.description
    expect(desc.startsWith('[MCP:s] 场景说明: 查知识库')).toBe(true)
  })
})

describe('组 10 annotations 跨线程投影', () => {
  it('annotations 经注册链路进入 McpToolMeta（防跨线程丢字段）', () => {
    registerMCPTools('s', [{
      name: 'echo',
      inputSchema: {type: 'object', properties: {}},
      annotations: {readOnlyHint: true},
    }], undefined, 'A')
    const meta = getAllMcpToolMeta().find(m => m.serverId === 's')
    expect(meta?.annotations).toEqual({readOnlyHint: true})
  })

  it('只含 title 的 annotations 经 adapter 归一后 meta 无该字段（防空壳判 write）', () => {
    registerMCPTools('s', [toMcpToolDefinition({
      name: 'echo',
      inputSchema: {type: 'object', properties: {}},
      annotations: {title: 'T'} as any,
    })], undefined, 'A')
    const meta = getAllMcpToolMeta().find(m => m.serverId === 's')
    expect(meta?.annotations).toBeUndefined()
  })
})

describe('组 11 override 承载（只读守卫 server 级覆写）', () => {
  it('override 经注册参数进入 McpToolMeta（只读守卫的 server 级覆写）', () => {
    registerMCPTools('s', [{
      name: 'frobnicate',
      inputSchema: {type: 'object', properties: {}},
    }], undefined, 'A', {unknownPolicy: 'allow', readOnlyTools: ['frobnicate']})
    const meta = getAllMcpToolMeta().find(m => m.serverId === 's')
    expect(meta?.override).toEqual({unknownPolicy: 'allow', readOnlyTools: ['frobnicate']})
  })

  it('三字段全空 → 不写 override 键（meta 不出现无意义空对象）', () => {
    const tool = [{name: 'frobnicate', inputSchema: {type: 'object', properties: {}}}] as any
    // 形态 1：payload 恒带三字段，未配置时为空数组 + undefined（mcpWorker 实际下发形态）
    registerMCPTools('s', tool, undefined, 'A', {readOnlyTools: [], writeTools: [], unknownPolicy: undefined})
    expect('override' in (getAllMcpToolMeta().find(m => m.serverId === 's') as any)).toBe(false)
    // 形态 2：完全不传第 5 参（主进程直连路径 registerMCPTools 的旧调用方）
    registerMCPTools('s', tool, undefined, 'A')
    expect('override' in (getAllMcpToolMeta().find(m => m.serverId === 's') as any)).toBe(false)
  })
})
