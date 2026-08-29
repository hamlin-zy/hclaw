import {describe, it, expect} from 'vitest'
import {buildMcpServersConfigJson, buildMcpDiagMessage} from '../../src/renderer/utils/mcpErrorPrompt'
import type {MCPServer} from '../../src/shared/types'

const baseServer = {
    id: 'srv-1',
    name: 'universal-email',
    transport: 'stdio',
    enabled: true,
} as MCPServer

describe('buildMcpServersConfigJson', () => {
    it('输出标准 mcpServers 格式，name 作为 key', () => {
        const json = buildMcpServersConfigJson({
            ...baseServer,
            command: 'npx',
            args: ['mcp-email'],
            env: {EMAIL_USER: 'a@b.com'},
        })
        const parsed = JSON.parse(json)
        expect(parsed.mcpServers).toBeDefined()
        expect(parsed.mcpServers['universal-email']).toEqual({
            transport: 'stdio',
            command: 'npx',
            args: ['mcp-email'],
            env: {EMAIL_USER: 'a@b.com'},
        })
        expect(parsed.name).toBeUndefined()
    })

    it('只包含非空的可选字段', () => {
        const parsed = JSON.parse(buildMcpServersConfigJson(baseServer))
        expect(parsed.mcpServers['universal-email']).toEqual({transport: 'stdio'})
    })
})

describe('buildMcpDiagMessage', () => {
    it('消息中包含标准格式 JSON、操作与报错信息，并要求以相同格式返回', () => {
        const msg = buildMcpDiagMessage({...baseServer, command: 'npx'}, 'test', 'spawn ENOENT')
        expect(msg).toContain('"mcpServers"')
        expect(msg).toContain('universal-email')
        expect(msg).toContain('操作: 测试连接')
        expect(msg).toContain('spawn ENOENT')
        expect(msg).toContain('相同的 mcpServers JSON 格式')
    })
})
