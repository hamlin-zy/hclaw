/**
 * mcpShortId 单元测试
 *
 * 覆盖 MCP 工具名前缀判断、shortId 哈希、工具名解析、shortId 映射构建与显示名解析。
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {
  isMcpToolName,
  shortenServerId,
  parseMcpToolName,
  extractMcpToolName,
  buildMcpShortIdMap,
  resolveMcpDisplayName,
} from '@shared/utils/mcpShortId'

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

  it('非 MCP 工具名返回 null', () => {
    expect(extractMcpToolName('')).toBeNull()
    expect(extractMcpToolName('file_read')).toBeNull()
  })
})

describe('buildMcpShortIdMap', () => {
  const servers = [
    {id: 'github', name: 'GitHub'},
    {id: 'codegraph', name: 'CodeGraph'},
    {id: 'plugin:github', name: 'GitHub Plugin'},
  ]

  it('为每个服务器构建 shortId → {name, isPlugin} 映射', () => {
    const map = buildMcpShortIdMap(servers)
    expect(map.get(shortenServerId('github'))).toEqual({name: 'GitHub', isPlugin: false})
    expect(map.get(shortenServerId('codegraph'))).toEqual({name: 'CodeGraph', isPlugin: false})
  })

  it('plugin: 前缀 id 标记 isPlugin=true', () => {
    const map = buildMcpShortIdMap(servers)
    expect(map.get(shortenServerId('plugin:github'))).toEqual({name: 'GitHub Plugin', isPlugin: true})
  })

  it('shortId 冲突时保留第一个', () => {
    // 相同 id 必然产生相同 shortId，验证冲突时只保留先出现的条目
    const map = buildMcpShortIdMap([
      {id: 'github', name: 'First'},
      {id: 'github', name: 'Second'},
    ])
    expect(map.size).toBe(1)
    expect(map.get(shortenServerId('github'))).toEqual({name: 'First', isPlugin: false})
  })

  it('空列表返回空 Map', () => {
    expect(buildMcpShortIdMap([]).size).toBe(0)
  })
})

describe('resolveMcpDisplayName', () => {
  const servers = [
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

  it('shortId 匹配（旧 mcp_ 与新格式 fallback）转换显示名', () => {
    const short = shortenServerId('codegraph')
    expect(resolveMcpDisplayName(`mcp_${short}_codegraph_explore`, servers)).toBe('m_CodeGraph_codegraph_explore')
    expect(resolveMcpDisplayName(`m_${short}_codegraph_explore`, servers)).toBe('m_CodeGraph_codegraph_explore')
  })

  it('插件通过 mp_ 前缀匹配 shortId', () => {
    const short = shortenServerId('plugin:github')
    expect(resolveMcpDisplayName(`mp_${short}_navigate_page`, servers)).toBe('mp_GitHub_navigate_page')
  })

  it('找不到返回 null', () => {
    expect(resolveMcpDisplayName('m_Unknown_foo', servers)).toBeNull()
    expect(resolveMcpDisplayName('m_CodeGraph_no_such_tool', servers)).toBeNull()
    expect(resolveMcpDisplayName('file_read', servers)).toBeNull()
    expect(resolveMcpDisplayName('', servers)).toBeNull()
  })
})

// ─── §9.5 显示名解析（§8.1 修复） ──────────────────────────────

describe('parseMcpToolName(knownServerNames)', () => {
  it('19. 长 serverName（10 位）精确剥离：toolName === navigate_page', () => {
    expect(parseMcpToolName('m_playwright_navigate_page', ['playwright'])).toEqual({
      shortId: null,
      toolName: 'navigate_page',
      serverName: 'playwright',
    })
  })

  it('20. 6 位 serverName 不再被误判为 shortId', () => {
    const parsed = parseMcpToolName('m_github_create_issue', ['github'])
    expect(parsed).toEqual({shortId: null, toolName: 'create_issue', serverName: 'github'})
    expect(parsed?.shortId).not.toBe('github')
  })

  it('mp_ 前缀插件 server 同样精确剥离', () => {
    expect(parseMcpToolName('mp_github_create_or_update_file', ['github'])).toEqual({
      shortId: null,
      toolName: 'create_or_update_file',
      serverName: 'github',
    })
  })

  it('旧 mcp_<serverName>_ 形式亦可剥离', () => {
    expect(parseMcpToolName('mcp_GitHub_create_issue', ['GitHub'])).toEqual({
      shortId: null,
      toolName: 'create_issue',
      serverName: 'GitHub',
    })
  })

  it('服务器名互为前缀时取最长匹配', () => {
    expect(parseMcpToolName('m_github_enterprise_create_issue', ['github', 'github_enterprise'])).toEqual({
      shortId: null,
      toolName: 'create_issue',
      serverName: 'github_enterprise',
    })
  })

  it('serverName 按注册时的净化规则比较（空格 → 下划线）', () => {
    expect(parseMcpToolName('m_My_Server_do_thing', ['My Server'])).toEqual({
      shortId: null,
      toolName: 'do_thing',
      serverName: 'My Server',
    })
  })

  it('列表未命中时回退到 6 位 hash 正则（shortId 形式仍可解析）', () => {
    expect(parseMcpToolName('m_6x7vml_navigate_page', ['github'])).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
  })

  it('剩余段异常（空 / 前导下划线）时回退，不误剥离', () => {
    // 服务器名命中前缀但剩余为空 → 回退 hash 正则 / fallback
    expect(parseMcpToolName('m_github_', ['github'])).toEqual({
      shortId: null,
      toolName: 'github_',
    })
    // 剩余含前导下划线（异常）→ 跳过前缀匹配，回退到原有 hash 正则
    expect(parseMcpToolName('m_github__tool', ['github'])).toEqual({
      shortId: 'github',
      toolName: '_tool',
    })
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
    expect(parseMcpToolName('mcp_6x7vml_navigate_page', [])).toEqual({
      shortId: '6x7vml',
      toolName: 'navigate_page',
    })
    expect(parseMcpToolName('m_github_create_issue', [])).toEqual({
      shortId: 'github',
      toolName: 'create_issue',
    })
  })

  it('非法名仍返回 null', () => {
    expect(parseMcpToolName('file_read', ['github'])).toBeNull()
    expect(parseMcpToolName('', ['github'])).toBeNull()
  })
})

describe('extractMcpToolName(knownServerNames)', () => {
  it('22. 传入列表时精确剥离 server 前缀（长名不再残留）', () => {
    expect(extractMcpToolName('m_playwright_navigate_page', ['playwright'])).toBe('navigate_page')
    expect(extractMcpToolName('m_github_create_issue', ['github'])).toBe('create_issue')
    expect(extractMcpToolName('mp_github_create_or_update_file', ['github'])).toBe('create_or_update_file')
    expect(extractMcpToolName('mcp_GitHub_create_issue', ['GitHub'])).toBe('create_issue')
  })

  it('互为前缀时取最长匹配', () => {
    expect(extractMcpToolName('m_github_enterprise_create_issue', ['github', 'github_enterprise'])).toBe('create_issue')
  })

  it('未命中时维持原有剥离行为', () => {
    expect(extractMcpToolName('m_6x7vml_navigate_page', ['github'])).toBe('navigate_page')
    expect(extractMcpToolName('m_playwright_navigate_page', ['github'])).toBe('playwright_navigate_page')
  })

  it('不传 / 空列表 → 与现有行为一致', () => {
    // 6 位被当 hash 剥掉（侥幸正确）
    expect(extractMcpToolName('m_github_create_issue')).toBe('create_issue')
    // 长名残留 server 名（信息不足，可接受）
    expect(extractMcpToolName('m_playwright_navigate_page')).toBe('playwright_navigate_page')
    expect(extractMcpToolName('m_playwright_navigate_page', [])).toBe('playwright_navigate_page')
  })

  it('非 MCP 名返回 null', () => {
    expect(extractMcpToolName('file_read', ['github'])).toBeNull()
    expect(extractMcpToolName('', ['github'])).toBeNull()
  })
})

describe('resolveMcpDisplayName 回归（23. 行为不变）', () => {
  const servers = [
    {id: 'codegraph', name: 'CodeGraph', tools: [{name: 'codegraph_explore'}, {name: 'query'}]},
    {id: 'plugin:github', name: 'GitHub', tools: [{name: 'create_or_update_file'}, {name: 'navigate_page'}]},
  ]

  it('统一格式 / 旧格式 / shortId 匹配结果保持不变', () => {
    expect(resolveMcpDisplayName('m_CodeGraph_codegraph_explore', servers)).toBe('m_CodeGraph_codegraph_explore')
    expect(resolveMcpDisplayName('mcp_CodeGraph_codegraph_explore', servers)).toBe('m_CodeGraph_codegraph_explore')
    expect(resolveMcpDisplayName(`mcp_${shortenServerId('codegraph')}_codegraph_explore`, servers)).toBe(
      'm_CodeGraph_codegraph_explore',
    )
    expect(resolveMcpDisplayName('m_Unknown_foo', servers)).toBeNull()
  })
})
