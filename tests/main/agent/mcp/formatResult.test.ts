/**
 * formatResult 单元测试
 *
 * 覆盖 MCP 工具调用结果的标准化格式化逻辑。
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {formatMcpResult} from '@/main/agent/mcp/formatResult'

describe('formatMcpResult', () => {
  it('单个 text 块 → output 为该文本', () => {
    const result = formatMcpResult({content: [{type: 'text', text: '你好'}]})
    expect(result).toEqual({success: true, output: '你好', error: undefined})
  })

  it('多个 text 块 → join(\'\\n\')', () => {
    const result = formatMcpResult({
      content: [
        {type: 'text', text: '第一行'},
        {type: 'text', text: '第二行'},
        {type: 'text', text: '第三行'},
      ],
    })
    expect(result.success).toBe(true)
    expect(result.output).toBe('第一行\n第二行\n第三行')
    expect(result.error).toBeUndefined()
  })

  it('无 content → output=(无输出)', () => {
    const result = formatMcpResult({})
    expect(result).toEqual({success: true, output: '(无输出)', error: undefined})
  })

  it('isError=true + 有文本 → success=false, output=\'\', error=文本', () => {
    const result = formatMcpResult({
      isError: true,
      content: [{type: 'text', text: '权限不足'}],
    })
    expect(result.success).toBe(false)
    expect(result.output).toBe('')
    expect(result.error).toBe('权限不足')
  })

  it('isError=true + 无文本 → error=\'MCP 工具执行失败\'', () => {
    const result = formatMcpResult({isError: true})
    expect(result.success).toBe(false)
    expect(result.output).toBe('')
    expect(result.error).toBe('MCP 工具执行失败')
  })

  it('混合 content（text + image + 其他类型）→ 只提取 text', () => {
    const result = formatMcpResult({
      content: [
        {type: 'text', text: '结果'},
        {type: 'image', data: 'base64', mimeType: 'image/png'},
        {type: 'resource', resource: {uri: 'file:///a.txt'}},
        {type: 'audio', data: 'x'},
      ],
    })
    expect(result.success).toBe(true)
    expect(result.output).toBe('结果')
    expect(result.error).toBeUndefined()
  })

  it('success 时 error undefined', () => {
    const result = formatMcpResult({content: [{type: 'text', text: 'ok'}]})
    expect(result).toEqual({success: true, output: 'ok', error: undefined})
    expect(result.error).toBeUndefined()
  })

  it('content 为空数组 → \'(无输出)\'', () => {
    const result = formatMcpResult({content: []})
    expect(result.success).toBe(true)
    expect(result.output).toBe('(无输出)')
    expect(result.error).toBeUndefined()
  })
})
