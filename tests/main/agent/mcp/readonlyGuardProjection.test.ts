/**
 * 只读守卫投影链路端到端测试（终审 I-1 修复）
 *
 * 动机：MCP SDK 的 ToolAnnotations 全字段可选（title / idempotentHint / openWorldHint 等）。
 * 若采集/投影层以「annotations 对象存在」为判据，只声明 title 的工具会被投影成空壳
 * {readOnlyHint: undefined, destructiveHint: undefined}；而下游 writeClassify 的判据是
 * `annotations !== undefined → readOnlyHint === true ? 'read' : 'write'`，空壳被判 write
 * → 该 server 全部工具在只读 Agent 下被误拦，且 unknownPolicy='allow' 逃生阀永不命中
 * （evaluateReadOnlyMcpAccess 对 verdict==='write' 直接拒绝，不看 unknownPolicy）。
 *
 * 本文件按真实链路构造：SDK tool → toMcpToolDefinition → toToolPayload（跨线程 payload）
 * → evaluateReadOnlyMcpAccess。
 */
import {describe, expect, it} from 'vitest'
import {toMcpToolDefinition} from '@/main/agent/mcp/sdkAdapter'
import {toToolPayload} from '@/main/agent/mcp/toolPayload'
import {evaluateReadOnlyMcpAccess} from '@/main/agent/mcp/writeClassify'

const inputSchema = {type: 'object' as const, properties: {}}

describe('I-1 无关标注不得投影为空壳（G1 恢复）', () => {
  it('只含 title 的 annotations：全链路无 annotations → codegraph_explore 按名字启发式放行', () => {
    const def = toMcpToolDefinition({
      name: 'codegraph_explore',
      inputSchema,
      annotations: {title: 'T'} as any,
    })
    expect('annotations' in def).toBe(false)

    const payload = toToolPayload(def)
    expect('annotations' in payload).toBe(false)

    expect(evaluateReadOnlyMcpAccess({
      rawToolName: 'codegraph_explore',
      annotations: payload.annotations,
      override: {unknownPolicy: 'allow'},
    })).toEqual({allowed: true})
  })

  it('unknownPolicy=allow 对真正 unknown 的工具仍生效（且无逃生阀时仍拒绝）', () => {
    const payload = toToolPayload(toMcpToolDefinition({name: 'frobnicate', inputSchema}))
    expect(evaluateReadOnlyMcpAccess({
      rawToolName: 'frobnicate',
      annotations: payload.annotations,
      override: {unknownPolicy: 'allow'},
    }).allowed).toBe(true)
    expect(evaluateReadOnlyMcpAccess({
      rawToolName: 'frobnicate',
      annotations: payload.annotations,
    }).allowed).toBe(false)
  })

  it('对照：手工构造的空壳 annotations 会被判 write（缺陷机理锁定，逃生阀不生效）', () => {
    expect(evaluateReadOnlyMcpAccess({
      rawToolName: 'codegraph_explore',
      annotations: {readOnlyHint: undefined, destructiveHint: undefined},
      override: {unknownPolicy: 'allow'},
    }).allowed).toBe(false)
  })

  it('真正声明 readOnlyHint 的 annotations 仍走标注分支（write 不被逃生阀放行）', () => {
    const payload = toToolPayload(toMcpToolDefinition({
      name: 'set_description',
      inputSchema,
      annotations: {readOnlyHint: false},
    }))
    expect(payload.annotations).toEqual({readOnlyHint: false})
    expect(evaluateReadOnlyMcpAccess({
      rawToolName: 'set_description',
      annotations: payload.annotations,
      override: {unknownPolicy: 'allow'},
    }).allowed).toBe(false)
  })
})
