// @vitest-environment node
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {
  ACK_TIMEOUT_MS,
  handleSendToConversation,
  resetSendToConversationPending,
  resolveSendToConversationAck,
  validateSendToConversationPayload,
  type SendToConversationDeps,
} from '../../../src/main/project-manager/sendToConversation'

const WS = '/home/me/proj'
const sender = {} as Electron.WebContents

function makeWin() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isLoadingMainFrame: vi.fn(() => false),
      send: vi.fn(),
    },
  }
}

function validPayload(over: Record<string, unknown> = {}) {
  return {requestId: 'req-1', workspacePath: WS, content: 'hello', target: {kind: 'new'}, ...over}
}

function makeDeps(over: Partial<SendToConversationDeps> = {}): SendToConversationDeps {
  return {
    isPmSender: vi.fn(() => true),
    listConvIds: vi.fn(async () => ['conv-a']),
    getMainWindow: vi.fn(() => makeWin() as never),
    ...over,
  }
}

beforeEach(() => resetSendToConversationPending())
afterEach(() => {
  vi.useRealTimers()
  resetSendToConversationPending()
})

describe('validateSendToConversationPayload', () => {
  it('合法 new 载荷通过', () => {
    expect(validateSendToConversationPayload(validPayload()).ok).toBe(true)
  })
  it('requestId 为空 → 非法', () => {
    expect(validateSendToConversationPayload(validPayload({requestId: ''}))).toEqual({ok: false, error: 'requestId 非法'})
  })
  it('workspacePath 非绝对路径 → 非法', () => {
    expect(validateSendToConversationPayload(validPayload({workspacePath: 'relative/path'})))
      .toEqual({ok: false, error: 'workspacePath 非法'})
  })
  it('content 为空 → 非法', () => {
    expect(validateSendToConversationPayload(validPayload({content: '   '})))
      .toEqual({ok: false, error: 'content 非法'})
  })
  it('target.kind 非 new/existing → 非法', () => {
    expect(validateSendToConversationPayload(validPayload({target: {kind: 'x'}})))
      .toEqual({ok: false, error: 'target.kind 非法'})
  })
  it('existing 的 conversationId 不匹配 conv- 前缀 → 非法', () => {
    expect(validateSendToConversationPayload(validPayload({target: {kind: 'existing', conversationId: 'abc'}})))
      .toEqual({ok: false, error: 'conversationId 非法'})
  })
  it('existing 的合法 conversationId 通过', () => {
    expect(validateSendToConversationPayload(validPayload({target: {kind: 'existing', conversationId: 'conv-1'}})).ok).toBe(true)
  })
})

describe('handleSendToConversation 校验分支', () => {
  it('载荷非法 → 返回校验错误', async () => {
    const r = await handleSendToConversation(validPayload({requestId: ''}), sender, makeDeps())
    expect(r).toEqual({ok: false, error: 'requestId 非法'})
  })
  it('发送方非法 → {ok:false, 非法发送方}', async () => {
    const r = await handleSendToConversation(validPayload(), sender, makeDeps({isPmSender: vi.fn(() => false)}))
    expect(r).toEqual({ok: false, error: '非法发送方'})
  })
  it('existing 目标不属于该项目 → 拒绝', async () => {
    const r = await handleSendToConversation(
      validPayload({target: {kind: 'existing', conversationId: 'conv-x'}}),
      sender,
      makeDeps({listConvIds: vi.fn(async () => ['conv-a'])}),
    )
    expect(r).toEqual({ok: false, error: '目标会话不属于该项目'})
  })
  it('主窗口不可用 → 拒绝', async () => {
    const r = await handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => null)}))
    expect(r).toEqual({ok: false, error: '主窗口不可用'})
  })
  it('主窗口未就绪 → 拒绝', async () => {
    const win = makeWin()
    win.webContents.isLoadingMainFrame = vi.fn(() => true)
    const r = await handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    expect(r).toEqual({ok: false, error: '主窗口未就绪'})
  })
})

describe('handleSendToConversation 转发与回执', () => {
  it('正常转发：send 携带 deliver 通道与载荷', async () => {
    const win = makeWin()
    const promise = handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    expect(win.webContents.send).toHaveBeenCalledWith('pm:send-to-conversation:deliver', validPayload())
    resolveSendToConversationAck({requestId: 'req-1', ok: true})
    await expect(promise).resolves.toEqual({ok: true})
  })

  it('最小化时先 restore，再 show + focus', async () => {
    const win = makeWin()
    win.isMinimized = vi.fn(() => true)
    const promise = handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    resolveSendToConversationAck({requestId: 'req-1', ok: true})
    await promise
  })

  it('ack 携带失败 → resolve {ok:false, error}', async () => {
    const win = makeWin()
    const promise = handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    resolveSendToConversationAck({requestId: 'req-1', ok: false, error: '目标会话不存在'})
    await expect(promise).resolves.toEqual({ok: false, error: '目标会话不存在'})
  })

  it('ack 携带 started:false → resolve 结果透传 started:false', async () => {
    const win = makeWin()
    const promise = handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    resolveSendToConversationAck({requestId: 'req-1', ok: true, started: false})
    await expect(promise).resolves.toEqual({ok: true, started: false})
  })

  it('ack 携带 started:true → resolve 结果携带 started:true', async () => {
    const win = makeWin()
    const promise = handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    resolveSendToConversationAck({requestId: 'req-1', ok: true, started: true})
    await expect(promise).resolves.toEqual({ok: true, started: true})
  })

  it('ack 超时 → {ok:false, error:主窗口未响应}', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    const promise = handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    await expect(promise).resolves.toEqual({ok: false, error: '主窗口未响应'})
  })

  it('不匹配的 requestId 的 ack 被忽略（不误 resolve）', async () => {
    const win = makeWin()
    const promise = handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    resolveSendToConversationAck({requestId: 'other', ok: true})
    resolveSendToConversationAck({requestId: 'req-1', ok: true})
    await expect(promise).resolves.toEqual({ok: true})
  })

  // F4：主窗口 send 同步抛出 → 立即 resolve 未响应，并清理 pending/timer（不留到超时）
  it('send 同步抛出 → resolve {ok:false,主窗口未响应} 且清理定时器', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    win.webContents.send.mockImplementation(() => { throw new Error('send failed') })
    const r = await handleSendToConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    expect(r).toEqual({ok: false, error: '主窗口未响应'})
    expect(vi.getTimerCount()).toBe(0)   // timer 已清、pending 无残留
  })
})
