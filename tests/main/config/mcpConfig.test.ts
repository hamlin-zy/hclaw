import {afterEach, describe, expect, it, vi} from 'vitest'
import {writeMcpConfig, readMcpConfig} from '@/main/config/mcpConfig'
import {MCP_TOOL_TIMEOUT_NO_LIMIT_MS} from '@/shared/types/mcp'
import type {McpServer} from '@/shared/types/mcp'
import fs from 'fs'
import path from 'path'

vi.mock('@/main/config', () => ({
  getHclawDir: () => '/tmp/test-hclaw',
}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

describe('mcpConfig checkUrl', () => {
  it('parseMcpServers preserves checkUrl from raw config', () => {
    const raw = {
      'my-binary': {
        command: '/path/to/binary',
        args: ['serve'],
        checkUrl: 'https://api.github.com/repos/owner/repo/releases/latest',
      },
    }
    // writeMcpConfig calls serializeMcpServers internally
    // readMcpConfig calls parseMcpServers internally
    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    const readSpy = vi.spyOn(fs, 'readFileSync')
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)

    writeSpy.mockImplementation(() => {})
    readSpy.mockReturnValue(JSON.stringify({
      mcpServers: {
        'my-binary': {
          command: '/path/to/binary',
          args: ['serve'],
          checkUrl: 'https://api.github.com/repos/owner/repo/releases/latest',
          enabled: true,
        },
      },
    }))

    const servers = readMcpConfig()
    expect(servers).toHaveLength(1)
    expect(servers[0].checkUrl).toBe('https://api.github.com/repos/owner/repo/releases/latest')

    writeSpy.mockRestore()
    readSpy.mockRestore()
    existsSpy.mockRestore()
  })

  it('serializeMcpServers includes checkUrl in output', () => {
    // Test via writeMcpConfig → read back serialized JSON
    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    writeSpy.mockImplementation((_path, data) => {
      const parsed = JSON.parse(data as string)
      expect(parsed.mcpServers['test-srv'].checkUrl).toBe('https://example.com/releases')
    })

    writeMcpConfig([{
      id: 'mcp-test',
      name: 'test-srv',
      transport: 'stdio',
      command: '/bin/foo',
      args: [],
      env: {},
      url: '',
      enabled: true,
      userDescription: '',
      checkUrl: 'https://example.com/releases',
    }])

    expect(writeSpy).toHaveBeenCalled()
    writeSpy.mockRestore()
    existsSpy.mockRestore()
  })
})

describe('mcpConfig 只读守卫策略字段', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parseMcpServers preserves readOnlyTools/writeTools/unknownPolicy', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const readSpy = vi.spyOn(fs, 'readFileSync')
    readSpy.mockReturnValue(JSON.stringify({
      mcpServers: {
        srv: {
          command: 'x',
          readOnlyTools: ['codegraph_explore'],
          writeTools: ['danger'],
          unknownPolicy: 'allow',
        },
      },
    }))
    const servers = readMcpConfig()
    expect(servers[0].readOnlyTools).toEqual(['codegraph_explore'])
    expect(servers[0].writeTools).toEqual(['danger'])
    expect(servers[0].unknownPolicy).toBe('allow')
  })

  it('serializeMcpServers 写出三字段（往返不丢）', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    writeMcpConfig([{
      id: 'srv', name: 'srv', transport: 'stdio', command: 'x', args: [], env: {},
      url: '', userDescription: '', enabled: true,
      readOnlyTools: ['codegraph_explore'], writeTools: [], unknownPolicy: 'allow',
    } as any])
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect(written.mcpServers.srv.readOnlyTools).toEqual(['codegraph_explore'])
    expect(written.mcpServers.srv.writeTools).toEqual([])
    expect(written.mcpServers.srv.unknownPolicy).toBe('allow')
  })

  it('缺省不写 unknownPolicy（未配置 ≠ 显式 deny）', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    writeMcpConfig([{
      id: 'srv', name: 'srv', transport: 'stdio', command: 'x', args: [], env: {},
      url: '', userDescription: '', enabled: true,
    } as any])
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect('unknownPolicy' in written.mcpServers.srv).toBe(false)
  })
})


describe('mcpConfig 工具调用超时缺省值（MCP 默认不限时 · 第 4 层）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('解析不含 timeout 的 mcp.json → 哨兵值（不再注入 60000）', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      mcpServers: {
        srv: {command: 'x'},
      },
    }))

    const servers = readMcpConfig()

    expect(servers[0].timeout).toBe(MCP_TOOL_TIMEOUT_NO_LIMIT_MS)
  })

  it('显式 timeout 原样保留（用户收紧超时的能力不被缺省覆盖）', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      mcpServers: {
        srv: {command: 'x', timeout: 5000},
      },
    }))

    expect(readMcpConfig()[0].timeout).toBe(5000)
  })

  it('序列化缺省 timeout → 写哨兵值（磁盘配置与运行期口径一致）', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    writeMcpConfig([{
      id: 'srv', name: 'srv', transport: 'stdio', command: 'x', args: [], env: {},
      url: '', userDescription: '', enabled: true,
    } as unknown as McpServer])

    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect(written.mcpServers.srv.timeout).toBe(MCP_TOOL_TIMEOUT_NO_LIMIT_MS)
  })
})
