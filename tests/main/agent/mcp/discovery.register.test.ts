import {beforeEach, describe, expect, it} from 'vitest'
import {registerMCPTools, registerAllMcpTools, unregisterMCPTools, getAllMcpToolMeta} from '@/main/agent/mcp/discovery'
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
