/**
 * MCP 工具命名单测 —— 由旧模块测试移植并扩写（旧文件位于 tests/shared/utils/，本次已删除）。
 *
 * 覆盖：前缀判定、shortId 哈希、server 段生成、候选名生成、候选驱动解析、显示名解析；
 * 并新增 组 1（哈希护栏）、组 2（候选降级链）、组 5（解析边界 + 段生成直测）、
 * 组 6（roundtrip 对称）、组 7（历史兼容）护栏。纯函数模块，无 IO 依赖。
 *
 * ─── 变异验证记录（对 src/shared/mcp/naming.ts 逐条实测；每次变异后即还原） ───
 * 组1  DJB2 初值 5381→5380            → 哈希断言变红                    ✅ 红
 * 组2  删 buildMcpServerSegments 候选② → 中文/emoji 候选（m_s_x）变红   ✅ 红
 * 组5a 候选段匹配加 /^[a-z0-9]{6}$/ 约束（模拟换回 {6} 正则）
 *                                      → shortId<6 位用例变红           ✅ 红
 * 组5b 删 buildMcpServerSegments 候选③ → 段列表直测变红                ✅ 红
 * 组6  去掉 buildMcpToolNameCandidates 对 toolName 的 sanitize
 *                                      → p.toolName==='a.b' 变红        ✅ 红
 * 组7  删 legacy 正则分支               → mcp_6x7vml_* 变红             ✅ 红
 * 新增② fallback prefixLen 去掉 mcp_→4（模拟回归）
 *                                      → mcp_GitHub_* / mcp_codegraph_* 变红 ✅ 红
 * 新增①(a) resolveMcpDisplayName (A) 段改回 server.name
 *                                      → m_My_Server_do_thing 变红      ✅ 红
 * 期望②③  resolveMcpDisplayName (B) 改回按 server.name 反查
 *                                      → 期望 4 条 shortId 段变红       ⚠️ 无红
 *
 * 两处与「变异点」表不符（实测证据，见 task-2-report.md）：
 * 1. 组1：roundtrip 用例**不变红** —— 生成侧与解析侧共用同一 shortenServerId，
 *    哈希被两侧同源抵消，属设计对称性。
 * 2. 期望②③：单独变异 (B) **不产生任何红** —— 短 hash 形式（如 `mcp_<hash>_…`）
 *    在「给了 servers」时先被候选驱动解析（候选③ 段即 shortenServerId）命中，走 (A)，
 *    根本到不了 (B)。这 4 条 shortId 段期望实际由 (A) 守护（即上一条「新增①(a)」变异，
 *    实测 4 条 shortId + 新条共 4~5 红）；(B) 仅对「候选未命中且 hash 不等于任何 server
 *    shortId」的输入可达，此时反查必然落空，故 (B) 的非 null 返回在本测试集内不可观测。
 */
import {describe, expect, it} from 'vitest'
import {
  isMcpToolName,
  sanitizeToolName,
  shortenServerId,
  buildMcpServerSegments,
  buildMcpToolNameCandidates,
  parseMcpToolName,
  extractMcpToolName,
  resolveMcpDisplayName,
  type McpServerIdentity,
} from '@shared/mcp/naming'

describe('isMcpToolName', () => {
  it('m_ / mp_ / mcp_ 前缀返回 true', () => {
    expect(isMcpToolName('m_codegraph_codegraph_explore')).toBe(true)
    expect(isMcpToolName('mp_github_create_or_update_file')).toBe(true)
    expect(isMcpToolName('mcp_6x7vml_navigate_page')).toBe(true)
    expect(isMcpToolName('m_6x7vml_navigate_page')).toBe(true)
  })

  it('其他前缀或空串返回 false', () => {
    expect(isMcpToolName('')).toBe(false)
    expect(isMcpToolName('codegraph_explore')).toBe(false)
    expect(isMcpToolName('file_read')).toBe(false)
    expect(isMcpToolName('mac_foo')).toBe(false)
    expect(isMcpToolName('mcpfoo')).toBe(false)
  })
})

describe('shortenServerId', () => {
  it('确定性：同输入同输出', () => {
    expect(shortenServerId('github')).toBe(shortenServerId('github'))
    expect(shortenServerId('codegraph')).toBe(shortenServerId('codegraph'))
  })

  it('输出为 base36 字符串（slice 截断，长度 ≤ 6）', () => {
    for (const id of ['github', 'codegraph', 'filesystem', 'plugin:github', 'a']) {
      const short = shortenServerId(id)
      expect(short).toMatch(/^[0-9a-z]{1,6}$/)
    }
    // 已知输入恰好 5 字符（slice(0,6) 不补零）
    expect(shortenServerId('github')).toBe('1vooo')
  })

  it('与已知值一致', () => {
    // DJB2 哈希 → base36，截取 6 位
    expect(shortenServerId('github')).toBe('1vooo')
    expect(shortenServerId('codegraph')).toBe('w39s0i')
  })

  it('不同输入通常产生不同 shortId', () => {
    expect(shortenServerId('github')).not.toBe(shortenServerId('gitlab'))
  })

  // ─── 组 1 补充护栏：算法不得改动（F8 其余哈希值） ────────────────
  it('组1 F8 其余哈希：plugin: / a / "" / plugin:github', () => {
    expect(shortenServerId('plugin:')).toBe('kmn86q')
    expect(shortenServerId('a')).toBe('3t3a')
    expect(shortenServerId('')).toBe('45h')
    expect(shortenServerId('plugin:github')).toBe('5rwqtt')
  })
})

describe('parseMcpToolName', () => {
  it('旧格式 mcp_<6位hash>_<toolName> 解析出 shortId 和 toolName', () => {
    expect(parseMcpToolName('mcp_6x7vml_navigate_page')).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
  })

  it('新格式 m_/mp_<6位hash>_<toolName> 解析出 shortId 和 toolName', () => {
    expect(parseMcpToolName('m_6x7vml_navigate_page')).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
    expect(parseMcpToolName('mp_6x7vml_create_or_update_file')).toEqual({
      shortId: '6x7vml',
      toolName: 'create_or_update_file',
    })
  })

  it('新格式 m_/mp_<服务器名>_<toolName>（服务器名非 6 位 hash）返回 shortId null', () => {
    // 服务器名含下划线（codegraph_codegraph_explore 前 6 位 codegr 非字母数字全 6 位规则）时走 fallback
    expect(parseMcpToolName('m_codegraph_codegraph_explore')).toEqual({
      shortId: null,
      toolName: 'codegraph_codegraph_explore',
    })
    // 服务器名恰好是 6 位字母数字时命中 hash 分支（实现行为）
    expect(parseMcpToolName('m_codegr_explore')).toEqual({
      shortId: 'codegr',
      toolName: 'explore',
    })
  })

  it('mp_ 前缀解析', () => {
    expect(parseMcpToolName('mp_6x7vml_navigate_page')).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
    // mp_<6位字母数字服务器名> 命中 hash 分支
    expect(parseMcpToolName('mp_github_create_or_update_file')).toEqual({
      shortId: 'github',
      toolName: 'create_or_update_file',
    })
  })

  // 回归护栏：mcp_ 落入「不可拆」fallback 时必须剥 4 字符（不得残留 p_）
  it('mcp_ 前缀 fallback 剥离 4 字符（不残留 p_）', () => {
    expect(parseMcpToolName('mcp_GitHub_navigate_page')).toEqual({
      shortId: null,
      toolName: 'GitHub_navigate_page',
    })
  })

  it('非法名返回 null', () => {
    expect(parseMcpToolName('')).toBeNull()
    expect(parseMcpToolName('file_read')).toBeNull()
    expect(parseMcpToolName('m_')).toBeNull()
    expect(parseMcpToolName('mp_')).toBeNull()
  })
})

describe('extractMcpToolName', () => {
  it('旧格式提取纯工具名', () => {
    expect(extractMcpToolName('mcp_6x7vml_navigate_page')).toBe('navigate_page')
  })

  it('新格式 hash fallback 提取纯工具名', () => {
    expect(extractMcpToolName('m_6x7vml_navigate_page')).toBe('navigate_page')
    expect(extractMcpToolName('mp_6x7vml_create_or_update_file')).toBe('create_or_update_file')
  })

  it('新格式服务器名提取完整剩余部分', () => {
    expect(extractMcpToolName('m_codegraph_codegraph_explore')).toBe('codegraph_codegraph_explore')
    // 6 位字母数字服务器名命中 hash 分支，去掉 m_<hash>_ 前缀
    expect(extractMcpToolName('mp_github_create_or_update_file')).toBe('create_or_update_file')
  })

  // 回归护栏：mcp_ 前缀落入「不可拆」fallback 时必须剥 4 字符（不得残留 p_）
  it('mcp_ 前缀 fallback 剥离 4 字符（不残留 p_）', () => {
    expect(extractMcpToolName('mcp_GitHub_navigate_page')).toBe('GitHub_navigate_page')
    expect(extractMcpToolName('mcp_codegraph_codegraph_explore')).toBe('codegraph_codegraph_explore')
    expect(extractMcpToolName('mcp_')).toBeNull()
  })

  it('非 MCP 工具名返回 null', () => {
    expect(extractMcpToolName('')).toBeNull()
    expect(extractMcpToolName('file_read')).toBeNull()
  })
})

describe('resolveMcpDisplayName', () => {
  const servers: McpServerIdentity[] = [
    {
      id: 'codegraph',
      name: 'CodeGraph',
      tools: [{name: 'codegraph_explore'}, {name: 'query'}],
    },
    {
      id: 'plugin:github',
      name: 'GitHub',
      tools: [{name: 'create_or_update_file'}, {name: 'navigate_page'}],
    },
  ]

  it('统一格式命中返回原名', () => {
    expect(resolveMcpDisplayName('m_CodeGraph_codegraph_explore', servers)).toBe('m_CodeGraph_codegraph_explore')
    expect(resolveMcpDisplayName('mp_GitHub_create_or_update_file', servers)).toBe('mp_GitHub_create_or_update_file')
  })

  it('旧 mcp_ 格式转换为新格式显示名', () => {
    expect(resolveMcpDisplayName('mcp_CodeGraph_codegraph_explore', servers)).toBe('m_CodeGraph_codegraph_explore')
    expect(resolveMcpDisplayName('mcp_GitHub_create_or_update_file', servers)).toBe('mp_GitHub_create_or_update_file')
  })

  it('shortId 匹配（旧 mcp_ 与新格式 fallback）转换显示名（server 段取命中段 = hash）', () => {
    const short = shortenServerId('codegraph')
    expect(resolveMcpDisplayName(`mcp_${short}_codegraph_explore`, servers)).toBe('m_w39s0i_codegraph_explore')
    expect(resolveMcpDisplayName(`m_${short}_codegraph_explore`, servers)).toBe('m_w39s0i_codegraph_explore')
  })

  it('插件通过 mp_ 前缀匹配 shortId（server 段取 hash）', () => {
    const short = shortenServerId('plugin:github')
    expect(resolveMcpDisplayName(`mp_${short}_navigate_page`, servers)).toBe('mp_5rwqtt_navigate_page')
  })

  it('找不到返回 null', () => {
    expect(resolveMcpDisplayName('m_Unknown_foo', servers)).toBeNull()
    expect(resolveMcpDisplayName('m_CodeGraph_no_such_tool', servers)).toBeNull()
    expect(resolveMcpDisplayName('file_read', servers)).toBeNull()
    expect(resolveMcpDisplayName('', servers)).toBeNull()
  })

  // ─── 行为变化 (a)：命中段含非法字符时，server 段显示为净化段（ASCII） ──
  it('mcp_<含非法字符的 serverName>_：server 段显示为净化段（ASCII）', () => {
    const s: McpServerIdentity[] = [{id: 's', name: 'My Server', tools: [{name: 'do_thing'}]}]
    expect(resolveMcpDisplayName('mcp_My_Server_do_thing', s)).toBe('m_My_Server_do_thing') // 旧值 'm_My Server_do_thing'
  })
})

// ─── §9.5 显示名解析（§8.1 修复）；含 server 感知的段/候选/解析/历史护栏 ────────

describe('parseMcpToolName(knownServerNames)', () => {
  it('19. 长 serverName（10 位）精确剥离：toolName === navigate_page', () => {
    expect(parseMcpToolName('m_playwright_navigate_page', [{id: 'playwright', name: 'playwright'}])).toEqual({
      serverId: 'playwright',
      serverName: 'playwright',
      matchedSegment: 'playwright',
      toolName: 'navigate_page',
      shortId: null,
    })
  })

  it('20. 6 位 serverName 不再被误判为 shortId', () => {
    const parsed = parseMcpToolName('m_github_create_issue', [{id: 'github', name: 'github'}])
    expect(parsed).toEqual({
      serverId: 'github',
      serverName: 'github',
      matchedSegment: 'github',
      toolName: 'create_issue',
      shortId: null,
    })
    expect(parsed?.shortId).not.toBe('github')
  })

  it('mp_ 前缀插件 server 同样精确剥离', () => {
    expect(parseMcpToolName('mp_github_create_or_update_file', [{id: 'github', name: 'github'}])).toEqual({
      serverId: 'github',
      serverName: 'github',
      matchedSegment: 'github',
      toolName: 'create_or_update_file',
      shortId: null,
    })
  })

  it('旧 mcp_<serverName>_ 形式亦可剥离', () => {
    expect(parseMcpToolName('mcp_GitHub_create_issue', [{id: 'GitHub', name: 'GitHub'}])).toEqual({
      serverId: 'GitHub',
      serverName: 'GitHub',
      matchedSegment: 'GitHub',
      toolName: 'create_issue',
      shortId: null,
    })
  })

  it('服务器名互为前缀时取最长匹配', () => {
    expect(
      parseMcpToolName('m_github_enterprise_create_issue', [
        {id: 'github', name: 'github'},
        {id: 'github_enterprise', name: 'github_enterprise'},
      ]),
    ).toEqual({
      serverId: 'github_enterprise',
      serverName: 'github_enterprise',
      matchedSegment: 'github_enterprise',
      toolName: 'create_issue',
      shortId: null,
    })
  })

  it('serverName 按注册时的净化规则比较（空格 → 下划线）', () => {
    expect(parseMcpToolName('m_My_Server_do_thing', [{id: 'my-server', name: 'My Server'}])).toEqual({
      serverId: 'my-server',
      serverName: 'My Server',
      matchedSegment: 'My_Server',
      toolName: 'do_thing',
      shortId: null,
    })
  })

  it('列表未命中时回退到 6 位 hash 正则（shortId 形式仍可解析）', () => {
    expect(parseMcpToolName('m_6x7vml_navigate_page', [{id: 'github', name: 'github'}])).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
  })

  it('剩余段异常（空 / 前导下划线）时回退，不误剥离', () => {
    // 服务器名命中前缀但剩余为空 → 回退 hash 正则 / fallback
    expect(parseMcpToolName('m_github_', [{id: 'github', name: 'github'}])).toEqual({
      shortId: null,
      toolName: 'github_',
    })
    // 剩余含前导下划线（异常）→ 跳过前缀匹配，回退到原有 hash 正则
    expect(parseMcpToolName('m_github__tool', [{id: 'github', name: 'github'}])).toEqual({
      shortId: 'github',
      toolName: '_tool',
    })
  })

  // ─── 组 2 降级链（fixture 的 serverId 必须为 ASCII，否则候选② 本就缺席、变异不红） ──
  it('组2-① 英文 serverName → 候选1 = m_My_Server_x', () => {
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: 'My Server', toolName: 'x'})[0]).toBe(
      'm_My_Server_x',
    )
  })

  it('组2-② 中文 serverName 净化后为空 → ① 缺席、落到候选② m_s_x', () => {
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: '知识库', toolName: 'x'})[0]).toBe('m_s_x')
  })

  it('组2-③ emoji serverName 净化后为空 → ① 缺席、落到候选② m_s_x', () => {
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: '🎯', toolName: 'x'})[0]).toBe('m_s_x')
  })

  it("组2-④ serverId === 'plugin:' 且无 name → ① 缺席、② 去前缀后为空 → 只剩候选③ mp_kmn86q_x", () => {
    expect(buildMcpToolNameCandidates({serverId: 'plugin:', serverName: undefined, toolName: 'x'})[0]).toBe(
      'mp_kmn86q_x',
    )
  })

  // ─── 组 5 · buildMcpServerSegments 直测（候选顺序 ①②③ / 去重 / ③ 恒在列） ──
  it('组5·段生成直测：顺序 ①②③ 与内容', () => {
    expect(buildMcpServerSegments({serverId: 's', serverName: 'My Server'})).toEqual(['My_Server', 's', '3t3s'])
  })

  it('组5·段生成直测：①=② 去重（serverId === serverName）', () => {
    expect(buildMcpServerSegments({serverId: 's', serverName: 's'})).toEqual(['s', '3t3s'])
  })

  it("组5·段生成直测：serverId === 'plugin:' 时候选② 缺席", () => {
    expect(buildMcpServerSegments({serverId: 'plugin:'})).toEqual(['kmn86q'])
  })

  it('组5·段生成直测：③ 恒在列（末段 === shortenServerId(serverId)）', () => {
    for (const id of ['s', 'plugin:', 'a', '', 'codegraph']) {
      const segs = buildMcpServerSegments({serverId: id})
      expect(segs[segs.length - 1]).toBe(shortenServerId(id))
    }
  })

  // ─── 组 5 · §3.5.3 边界表（第 12 行「历史名」由组 7 覆盖） ──────────────
  it('§3.5.3-1 serverName "" 与 undefined 等价（候选1 均缺席）', () => {
    expect(buildMcpServerSegments({serverId: 's', serverName: ''})).toEqual(
      buildMcpServerSegments({serverId: 's'}),
    )
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: '', toolName: 'x'})).toEqual(
      buildMcpToolNameCandidates({serverId: 's', toolName: 'x'}),
    )
  })

  it('§3.5.3-2 serverName 含下划线 → 注册名 m_My_Server_x，解析回原始名', () => {
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: 'My Server', toolName: 'x'})[0]).toBe(
      'm_My_Server_x',
    )
    expect(parseMcpToolName('m_My_Server_x', [{id: 's', name: 'My Server'}])).toEqual({
      serverId: 's',
      serverName: 'My Server',
      matchedSegment: 'My_Server',
      toolName: 'x',
      shortId: null,
    })
  })

  it("§3.5.3-3 serverId === 'plugin:' → 候选2 缺席 → 落到候选3 mp_kmn86q_…", () => {
    expect(buildMcpServerSegments({serverId: 'plugin:'})).toEqual(['kmn86q'])
    expect(buildMcpToolNameCandidates({serverId: 'plugin:', serverName: undefined, toolName: 'x'})).toEqual([
      'mp_kmn86q_x',
    ])
  })

  it("§3.5.3-4 serverId === 'plugin:a:b' → 候选2 = a_b", () => {
    expect(sanitizeToolName('a:b')).toBe('a_b')
    expect(buildMcpServerSegments({serverId: 'plugin:a:b'})[0]).toBe('a_b')
    expect(buildMcpToolNameCandidates({serverId: 'plugin:a:b', toolName: 'x'})[0]).toBe('mp_a_b_x')
  })

  it('§3.5.3-5 serverId === serverName → 候选列表长度 = 2（① 与 ② 去重）', () => {
    expect(buildMcpServerSegments({serverId: 's', serverName: 's'})).toHaveLength(2)
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: 's', toolName: 'x'})).toHaveLength(2)
  })

  it('§3.5.3-6 serverName 净化后等于另一 server 的 shortId → 命中确定（同长取 id 升序第一个）', () => {
    // 'w39s0i' 同时是 codegraph 的候选③段 与 custom 的候选①段（名字段）
    const a = parseMcpToolName('m_w39s0i_foo', [
      {id: 'codegraph', name: 'CodeGraph'},
      {id: 'custom', name: 'w39s0i'},
    ])
    const b = parseMcpToolName('m_w39s0i_foo', [
      {id: 'custom', name: 'w39s0i'},
      {id: 'codegraph', name: 'CodeGraph'},
    ])
    // 确定性：与传入顺序无关；同长段取 id 升序第一个（'codegraph' < 'custom'）
    expect(a).toEqual(b)
    expect(a?.serverId).toBe('codegraph')
    expect(a?.matchedSegment).toBe('w39s0i')
  })

  it("§3.5.3-7 toolName 含非法字符（a.b）→ safeTool === 'a_b'", () => {
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: 's', toolName: 'a.b'})[0]).toBe('m_s_a_b')
    expect(parseMcpToolName('m_s_a_b', [{id: 's', name: 's'}])?.toolName).toBe('a_b')
  })

  it('§3.5.3-8 toolName 净化后为空（___ / 中文）→ safeTool 走 shortenServerId(toolName)', () => {
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: 's', toolName: '___'})[0]).toBe('m_s_3770yq')
    expect(buildMcpToolNameCandidates({serverId: 's', serverName: 's', toolName: '知识库'})[0]).toBe('m_s_3rqz37')
  })

  it('§3.5.3-9 候选耗尽后缀被并入 toolName（解析侧已知限制）', () => {
    expect(parseMcpToolName('m_s_a_b_2', [{id: 's', name: 's'}])?.toolName).toBe('a_b_2')
  })

  it('§3.5.3-10 shortId 不足 6 位（a → 3t3a）带 servers 可命中', () => {
    expect(shortenServerId('a')).toBe('3t3a')
    expect(parseMcpToolName('m_3t3a_x', [{id: 'a', name: 'a'}])).toEqual({
      serverId: 'a',
      serverName: 'a',
      matchedSegment: '3t3a',
      toolName: 'x',
      shortId: null,
    })
  })

  it("§3.5.3-11 serverId === ''（hash 45h）同上可命中", () => {
    expect(shortenServerId('')).toBe('45h')
    expect(parseMcpToolName('m_45h_x', [{id: '', name: ''}])).toEqual({
      serverId: '',
      serverName: '',
      matchedSegment: '45h',
      toolName: 'x',
      shortId: null,
    })
  })

  // ─── 组 6 roundtrip 对称（段级定义，禁止自我掩盖） ─────────────────
  it('组6 roundtrip：候选与解析在段层面对称，toolName 已净化', () => {
    const c = buildMcpToolNameCandidates({serverId: 's', serverName: 's', toolName: 'a.b'})[0]
    const p = parseMcpToolName(c, [{id: 's', name: 's'}])!
    expect(p.serverId).toBe('s')
    expect(p.toolName).toBe('a_b') // 直接断净化后的段，不再套一层 sanitizeToolName
    expect(p.toolName).not.toBe('a.b')
  })
})

describe('parseMcpToolName 向后兼容（不传 / 空列表）', () => {
  it('21. 不传 knownServerNames → 维持原有行为', () => {
    // 旧格式 mcp_<6位hash>_*
    expect(parseMcpToolName('mcp_6x7vml_navigate_page')).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
    // 新格式 hash fallback
    expect(parseMcpToolName('m_6x7vml_navigate_page')).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
    // 6 位 serverName 仍被当作 hash（未提供列表时的既有行为，不做改变）
    expect(parseMcpToolName('m_github_create_issue')).toEqual({
      shortId: 'github',
      toolName: 'create_issue',
    })
    // 长 serverName 走 fallback
    expect(parseMcpToolName('m_playwright_navigate_page')).toEqual({
      shortId: null,
      toolName: 'playwright_navigate_page',
    })
  })

  it('21. 传入空列表 → 同样维持原有行为', () => {
    expect(parseMcpToolName('mcp_6x7vml_navigate_page', [] as McpServerIdentity[])).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
    expect(parseMcpToolName('m_github_create_issue', [] as McpServerIdentity[])).toEqual({
      shortId: 'github',
      toolName: 'create_issue',
    })
  })

  it('非法名仍返回 null', () => {
    expect(parseMcpToolName('file_read', [{id: 'github', name: 'github'}])).toBeNull()
    expect(parseMcpToolName('', [{id: 'github', name: 'github'}])).toBeNull()
  })

  // ─── 组 7 历史兼容（§3.5.3 第 12 行） ────────────────────────────
  it('组7 历史兼容：mcp_<hash>_ / m_<hash>_ / mp_<hash>_ 仍可解析（legacy 护栏）', () => {
    expect(parseMcpToolName('mcp_6x7vml_navigate_page')).toEqual({shortId: '6x7vml', toolName: 'navigate_page'})
    expect(parseMcpToolName('m_6x7vml_navigate_page')).toEqual({shortId: '6x7vml', toolName: 'navigate_page'})
    expect(parseMcpToolName('mp_6x7vml_create_or_update_file')).toEqual({
      shortId: '6x7vml',
      toolName: 'create_or_update_file',
    })
  })
})

describe('extractMcpToolName(knownServerNames)', () => {
  it('22. 传入列表时精确剥离 server 前缀（长名不再残留）', () => {
    expect(extractMcpToolName('m_playwright_navigate_page', [{id: 'playwright', name: 'playwright'}])).toBe(
      'navigate_page',
    )
    expect(extractMcpToolName('m_github_create_issue', [{id: 'github', name: 'github'}])).toBe('create_issue')
    expect(extractMcpToolName('mp_github_create_or_update_file', [{id: 'github', name: 'github'}])).toBe(
      'create_or_update_file',
    )
    expect(extractMcpToolName('mcp_GitHub_create_issue', [{id: 'GitHub', name: 'GitHub'}])).toBe('create_issue')
  })

  it('互为前缀时取最长匹配', () => {
    expect(
      extractMcpToolName('m_github_enterprise_create_issue', [
        {id: 'github', name: 'github'},
        {id: 'github_enterprise', name: 'github_enterprise'},
      ]),
    ).toBe('create_issue')
  })

  it('未命中时维持原有剥离行为', () => {
    expect(extractMcpToolName('m_6x7vml_navigate_page', [{id: 'github', name: 'github'}])).toBe('navigate_page')
    expect(extractMcpToolName('m_playwright_navigate_page', [{id: 'github', name: 'github'}])).toBe(
      'playwright_navigate_page',
    )
  })

  it('不传 / 空列表 → 与现有行为一致', () => {
    // 6 位被当 hash 剥掉（侥幸正确）
    expect(extractMcpToolName('m_github_create_issue')).toBe('create_issue')
    // 长名残留 server 名（信息不足，可接受）
    expect(extractMcpToolName('m_playwright_navigate_page')).toBe('playwright_navigate_page')
    expect(extractMcpToolName('m_playwright_navigate_page', [] as McpServerIdentity[])).toBe(
      'playwright_navigate_page',
    )
  })

  it('非 MCP 名返回 null', () => {
    expect(extractMcpToolName('file_read', [{id: 'github', name: 'github'}])).toBeNull()
    expect(extractMcpToolName('', [{id: 'github', name: 'github'}])).toBeNull()
  })
})

describe('resolveMcpDisplayName 回归（23. 行为不变）', () => {
  const servers: McpServerIdentity[] = [
    {id: 'codegraph', name: 'CodeGraph', tools: [{name: 'codegraph_explore'}, {name: 'query'}]},
    {id: 'plugin:github', name: 'GitHub', tools: [{name: 'create_or_update_file'}, {name: 'navigate_page'}]},
  ]

  it('统一格式 / 旧格式 / shortId 匹配结果保持不变', () => {
    expect(resolveMcpDisplayName('m_CodeGraph_codegraph_explore', servers)).toBe('m_CodeGraph_codegraph_explore')
    expect(resolveMcpDisplayName('mcp_CodeGraph_codegraph_explore', servers)).toBe('m_CodeGraph_codegraph_explore')
    expect(resolveMcpDisplayName(`mcp_${shortenServerId('codegraph')}_codegraph_explore`, servers)).toBe(
      'm_w39s0i_codegraph_explore',
    )
    expect(resolveMcpDisplayName('m_Unknown_foo', servers)).toBeNull()
  })
})
