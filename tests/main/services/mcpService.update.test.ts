import {describe, it, expect, vi, beforeEach} from 'vitest'

vi.mock('@/main/agent/logger', () => ({
  createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}),
}))

vi.mock('@/main/config/mcpConfig', () => ({
  readMcpConfig: () => [],
  writeMcpConfig: vi.fn(() => true),
}))

import {MCPServerService} from '@/main/services/mcpService'
import {writeMcpConfig} from '@/main/config/mcpConfig'

describe('MCPServerService.update', () => {
  let service: MCPServerService

  function seedServer() {
    service.add({
      id: 'srv-1',
      name: 'test',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@foo/mcp'],
      env: {},
      url: '',
      userDescription: '',
      enabled: true,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    service = new MCPServerService()
  })

  it('merges patch into existing server and preserves runtime + unrelated config fields', () => {
    seedServer()
    // Establish a realistic connected state via updateStatus (public API).
    service.updateStatus('srv-1', 'connected', undefined, [{name: 'tool1'}])
    // Clear the mock so we only count calls made by update() below.
    vi.clearAllMocks()

    const listChangedListener = vi.fn()
    service.onEvent(listChangedListener)

    const result = service.update('srv-1', {
      args: ['-y', '@foo/mcp@2.0.0', '--quiet'],
    })

    expect(result).toBe(true)
    const updated = service.get('srv-1')!
    // Patch applied.
    expect(updated.args).toEqual(['-y', '@foo/mcp@2.0.0', '--quiet'])
    // Runtime fields preserved (not part of Partial<McpServer>).
    expect(updated.status).toBe('connected')
    expect(updated.errorDetail).toBe('')
    expect(updated.tools).toEqual([{name: 'tool1'}])
    // Unrelated config fields preserved (not present in patch).
    expect(updated.enabled).toBe(true)
    expect(updated.command).toBe('npx')
    expect(updated.name).toBe('test')
    // Full server list written to mcp.json.
    expect(writeMcpConfig).toHaveBeenCalledTimes(1)
    // list-changed event fired.
    expect(listChangedListener).toHaveBeenCalledTimes(1)
  })

  it('returns false when the id is not found and does not write to mcp.json', () => {
    seedServer()
    vi.clearAllMocks()

    const result = service.update('missing', {args: ['whatever']})
    expect(result).toBe(false)
    expect(writeMcpConfig).not.toHaveBeenCalled()
  })

  it('overrides enabled when the patch explicitly includes it', () => {
    seedServer()
    const result = service.update('srv-1', {enabled: false})
    expect(result).toBe(true)
    expect(service.get('srv-1')!.enabled).toBe(false)
  })
})
