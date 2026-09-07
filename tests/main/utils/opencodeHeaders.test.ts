// tests/main/utils/opencodeHeaders.test.ts
import {describe, it, expect} from 'vitest'
import {withOpenCodeHeaders} from '../../../src/main/utils/opencodeHeaders'

describe('withOpenCodeHeaders', () => {
  it('opencode.ai 域名注入 UA + x-opencode-session', () => {
    const init = withOpenCodeHeaders('https://opencode.ai/zen/go/v1/chat/completions', {headers: {'Authorization': 'Bearer k'}}, 'conv-1')
    const h = new Headers(init.headers)
    expect(h.get('User-Agent')).toMatch(/^HClaw\//)
    expect(h.get('x-opencode-session')).toBe('conv-1')
    expect(h.get('Authorization')).toBe('Bearer k')
  })

  it('子域名同样生效', () => {
    const h = new Headers(withOpenCodeHeaders('https://api.opencode.ai/v1/models', undefined, 'c').headers)
    expect(h.get('x-opencode-session')).toBe('c')
  })

  it('其他域名不注入、不修改原始 init', () => {
    const original = {headers: {'X-A': '1'}}
    const init = withOpenCodeHeaders('https://api.deepseek.com/v1/chat/completions', original, 'c')
    const h = new Headers(init.headers)
    expect(h.get('x-opencode-session')).toBeNull()
    expect(h.get('User-Agent')).toBeNull()
    expect(init).toBe(original)
  })

  it('非法 URL 不抛出且不注入', () => {
    const init = withOpenCodeHeaders('not-a-url', undefined)
    expect(init).toEqual({})
  })

  it('无会话上下文回退进程级 session ID', () => {
    const h = new Headers(withOpenCodeHeaders('https://opencode.ai/v1/chat/completions', undefined).headers)
    expect(h.get('x-opencode-session')).toMatch(/^.{8,}$/)
  })

  it('无条件覆盖 SDK 自带的 User-Agent（满足标识要求）', () => {
    const h = new Headers(withOpenCodeHeaders('https://opencode.ai/v1', {headers: {'User-Agent': 'OpenAI/JS 6.45.0'}}, 'c').headers)
    expect(h.get('User-Agent')).toMatch(/^HClaw\//)
  })

  it('URL 形态边界：端口、http、大写域名、URL 对象、Request 对象', () => {
    // 带端口仍是 opencode.ai → 注入
    expect(new Headers(withOpenCodeHeaders('https://opencode.ai:8443/v1', undefined, 'c').headers).get('x-opencode-session')).toBe('c')
    // http 协议同样注入
    expect(new Headers(withOpenCodeHeaders('http://opencode.ai/v1', undefined, 'c').headers).get('x-opencode-session')).toBe('c')
    // 大写域名（URL 构造器保留原样大小写 → endsWith 匹配）
    expect(new Headers(withOpenCodeHeaders('https://OPENCODE.AI/v1', undefined, 'c').headers).get('x-opencode-session')).toBe('c')
    // URL 对象输入
    expect(new Headers(withOpenCodeHeaders(new URL('https://opencode.ai/v1'), undefined, 'c').headers).get('x-opencode-session')).toBe('c')
    // Request 对象输入
    const req = new Request('https://opencode.ai/v1/chat/completions')
    expect(new Headers(withOpenCodeHeaders(req, undefined, 'c').headers).get('x-opencode-session')).toBe('c')
    // 相似域名（slopencode.ai）不注入
    expect(new Headers(withOpenCodeHeaders('https://slopencode.ai/v1', undefined, 'c').headers).get('x-opencode-session')).toBeNull()
  })

  it('同一会话多次调用 session ID 稳定（缓存命中前提）', () => {
    const url = 'https://opencode.ai/v1/chat/completions'
    const a = new Headers(withOpenCodeHeaders(url, undefined, 'conv-42').headers).get('x-opencode-session')
    const b = new Headers(withOpenCodeHeaders(url, undefined, 'conv-42').headers).get('x-opencode-session')
    expect(a).toBe(b)
    // 不同会话 ID 不同
    const c = new Headers(withOpenCodeHeaders(url, undefined, 'conv-43').headers).get('x-opencode-session')
    expect(c).not.toBe(a)
  })

  it('进程级回退 session ID 跨调用稳定', () => {
    const url = 'https://opencode.ai/v1/chat/completions'
    const a = new Headers(withOpenCodeHeaders(url, undefined).headers).get('x-opencode-session')
    const b = new Headers(withOpenCodeHeaders(url, undefined).headers).get('x-opencode-session')
    expect(a).toBe(b)
  })
})

// ── 集成：recordingFetch 注入透传 ──
import {vi} from 'vitest'
import {recordingFetch, runWithLlmTraceContext, setRecordingEnabled} from '../../../src/main/utils/llmTraceRecorder'

describe('recordingFetch 集成', () => {
  it('录制关闭时同样注入合规头（关闭录制不得绕过合规）', async () => {
    setRecordingEnabled(false)
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    const {__setDepsForTest} = await import('../../../src/main/utils/llmTraceRecorder')
    __setDepsForTest({upstreamFetch: upstream})
    try {
      await runWithLlmTraceContext(
        {conversationId: 'conv-9', turn: 1, step: 1, attempt: 0, provider: 'p', model: 'm', apiStyle: 'chat', context: 'main'},
        () => recordingFetch('https://opencode.ai/zen/go/v1/chat/completions', {headers: {'Authorization': 'Bearer k'}}),
      )
      const init = upstream.mock.calls[0][1] as RequestInit
      const h = new Headers(init.headers)
      expect(h.get('x-opencode-session')).toBe('conv-9')
      expect(h.get('User-Agent')).toMatch(/^HClaw\//)
      // 非 opencode 域名不注入
      await recordingFetch('https://api.deepseek.com/v1/chat/completions', {headers: {}})
      const init2 = upstream.mock.calls[1][1] as RequestInit
      expect(new Headers(init2.headers).get('x-opencode-session')).toBeNull()
    } finally {
      setRecordingEnabled(true)
      __setDepsForTest({})
    }
  })
})
