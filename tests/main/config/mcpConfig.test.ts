import {describe, expect, it, vi} from 'vitest'
import {writeMcpConfig, readMcpConfig} from '@/main/config/mcpConfig'
import fs from 'fs'
import path from 'path'

vi.mock('@/main/config', () => ({
  getHclawDir: () => '/tmp/test-hclaw',
}))

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
