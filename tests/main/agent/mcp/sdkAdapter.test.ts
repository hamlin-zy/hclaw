/**
 * sdkAdapter 单元测试
 *
 * 覆盖 MCP SDK 类型到 HClaw 内部 MCP 类型的映射。
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {toMcpToolDefinition, toMcpToolCallResult} from '@/main/agent/mcp/sdkAdapter'

describe('toMcpToolDefinition', () => {
  it('完整 tool → 三字段透传', () => {
    const input = {
      name: 'read_file',
      description: '读取文件',
      inputSchema: {type: 'object' as const, properties: {path: {type: 'string'}}, required: ['path']},
    }
    const def = toMcpToolDefinition(input)
    expect(def).toEqual(input)
    expect(def.name).toBe('read_file')
    expect(def.description).toBe('读取文件')
    expect(def.inputSchema).toBe(input.inputSchema)
  })

  it('无 description → description undefined', () => {
    const def = toMcpToolDefinition({
      name: 'echo',
      inputSchema: {type: 'object', properties: {}},
    })
    expect(def.name).toBe('echo')
    expect(def.description).toBeUndefined()
    expect(def).toEqual({name: 'echo', description: undefined, inputSchema: {type: 'object', properties: {}}})
  })

  it('inputSchema 原样保留（properties/required）', () => {
    const schema = {
      type: 'object',
      properties: {url: {type: 'string'}, depth: {type: 'number'}},
      required: ['url'],
    }
    const def = toMcpToolDefinition({name: 'fetch', inputSchema: schema})
    expect(def.inputSchema).toBe(schema)
    expect(def.inputSchema.required).toEqual(['url'])
    expect(def.inputSchema.properties).toEqual({url: {type: 'string'}, depth: {type: 'number'}})
  })
})

describe('toMcpToolCallResult', () => {
  it('TextContent → {type:\'text\', text}', () => {
    const r = toMcpToolCallResult({content: [{type: 'text', text: 'hi'}]})
    expect(r.content).toEqual([{type: 'text', text: 'hi'}])
  })

  it('ImageContent → {type:\'image\', data, mimeType}', () => {
    const r = toMcpToolCallResult({
      content: [{type: 'image', data: 'aGVsbG8=', mimeType: 'image/png'}],
    })
    expect(r.content).toEqual([{type: 'image', data: 'aGVsbG8=', mimeType: 'image/png'}])
  })

  it('EmbeddedResource → {type:\'resource\', resource}', () => {
    const resource = {uri: 'file:///a.txt', mimeType: 'text/plain', text: '内容'}
    const r = toMcpToolCallResult({content: [{type: 'resource', resource}]})
    expect(r.content).toEqual([{type: 'resource', resource}])
  })

  it('AudioContent → 占位 {type:\'text\', text:\'\'}', () => {
    const r = toMcpToolCallResult({
      content: [{type: 'audio', data: 'AQID', mimeType: 'audio/wav'}],
    })
    expect(r.content).toEqual([{type: 'text', text: ''}])
  })

  it('ResourceLink → 占位', () => {
    const r = toMcpToolCallResult({
      content: [{type: 'resourceLink', uri: 'file:///link.txt', mimeType: 'text/plain'}],
    })
    expect(r.content).toEqual([{type: 'text', text: ''}])
  })

  it('混合多个 → 顺序保持', () => {
    const r = toMcpToolCallResult({
      content: [
        {type: 'text', text: '第一'},
        {type: 'image', data: 'img', mimeType: 'image/png'},
        {type: 'audio', data: 'aud', mimeType: 'audio/mp3'},
        {type: 'resource', resource: {uri: 'file:///b.txt'}},
      ],
    })
    expect(r.content.map(c => c.type)).toEqual(['text', 'image', 'text', 'resource'])
    expect(r.content[0]).toEqual({type: 'text', text: '第一'})
    expect(r.content[1]).toEqual({type: 'image', data: 'img', mimeType: 'image/png'})
    expect(r.content[2]).toEqual({type: 'text', text: ''})
    expect(r.content[3]).toEqual({type: 'resource', resource: {uri: 'file:///b.txt'}})
  })

  it('isError 默认 false；显式 true → true', () => {
    expect(toMcpToolCallResult({content: []}).isError).toBe(false)
    expect(toMcpToolCallResult({content: [], isError: true}).isError).toBe(true)
  })

  it('resource 缺省 → resource 兜底 {uri:\'\'}', () => {
    const r = toMcpToolCallResult({content: [{type: 'resource'}]})
    expect(r.content).toEqual([{type: 'resource', resource: {uri: ''}}])
  })
})
