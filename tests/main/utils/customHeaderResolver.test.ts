// tests/main/utils/customHeaderResolver.test.ts
import {describe, it, expect} from 'vitest'
import {resolveCustomHeaders} from '../../../src/main/utils/customHeaderResolver'
import type {ProviderCustomHeader} from '../../../src/shared/types/model'

const makeHeader = (partial: Partial<ProviderCustomHeader>): ProviderCustomHeader => ({
  id: 'h1',
  providerId: 'p1',
  headerName: 'X-Custom',
  ...partial,
})

describe('resolveCustomHeaders', () => {
  it('prefix + system.version 拼接（如 "Bearer " + 版本号之外的场景）', () => {
    const result = resolveCustomHeaders([
      makeHeader({headerName: 'X-Client', prefix: 'HClaw/', variable: 'system.version'}),
    ])
    expect(result['X-Client']).toMatch(/^HClaw\/\S+/)
  })

  it('prefix + session.id 拼接（使用传入 sessionId）', () => {
    const result = resolveCustomHeaders([
      makeHeader({headerName: 'X-Session', prefix: 'hclaw-', variable: 'session.id'}),
    ], 'conv-42')
    expect(result['X-Session']).toBe('hclaw-conv-42')
  })

  it('session.id 无 sessionId 时回退进程级 ID（非空稳定值）', () => {
    const result = resolveCustomHeaders([
      makeHeader({headerName: 'X-Session', prefix: 'hclaw-', variable: 'session.id'}),
    ])
    expect(result['X-Session']).toMatch(/^hclaw-.+/)
  })

  it('variable 为 undefined = 纯静态值（仅 prefix）', () => {
    const result = resolveCustomHeaders([
      makeHeader({headerName: 'X-Static', prefix: 'fixed-value'}),
    ])
    expect(result['X-Static']).toBe('fixed-value')
  })

  it('未知 variable 跳过该行', () => {
    const result = resolveCustomHeaders([
      makeHeader({headerName: 'X-Bad', prefix: 'p-', variable: 'unknown.var' as never}),
      makeHeader({headerName: 'X-Good', prefix: 'ok'}),
    ])
    expect(result['X-Bad']).toBeUndefined()
    expect(result['X-Good']).toBe('ok')
  })

  it('headerName 为空/空白跳过', () => {
    const result = resolveCustomHeaders([
      makeHeader({headerName: '', prefix: 'a'}),
      makeHeader({headerName: '   ', prefix: 'b'}),
    ])
    expect(result).toEqual({})
  })

  it('undefined/空数组返回空对象', () => {
    expect(resolveCustomHeaders(undefined)).toEqual({})
    expect(resolveCustomHeaders([])).toEqual({})
  })
})
