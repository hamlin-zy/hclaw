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
