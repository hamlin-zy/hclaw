// @vitest-environment node
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {
  OPEN_CONVERSATION_ACK_TIMEOUT_MS,
  handleOpenConversation,
  resetOpenConversationPending,
  resolveOpenConversationAck,
  validateOpenConversationPayload,
  type OpenConversationDeps,
} from '../../../src/main/utils/openConversation'

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
  return {requestId: 'req-1', conversationId: 'conv-a', workspacePath: WS, ...over}
}

function makeDeps(over: Partial<OpenConversationDeps> = {}): OpenConversationDeps {
  return {
    isAllowedSender: vi.fn(() => true),
    listConvIdsInWorkspace: vi.fn(async () => ['conv-a']),
    getMainWindow: vi.fn(() => makeWin() as never),
    ...over,
  }
}

/** handleOpenConversation 在转发前有 await（归属校验），断言前需先让微任务链跑完 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => resetOpenConversationPending())
afterEach(() => {
  vi.useRealTimers()
  resetOpenConversationPending()
})

describe('validateOpenConversationPayload', () => {
  it('合法载荷通过', () => {
    expect(validateOpenConversationPayload(validPayload())).toEqual({
      ok: true,
      value: {requestId: 'req-1', conversationId: 'conv-a', workspacePath: WS},
    })
  })
  it('非对象载荷 → 载荷非法', () => {
    expect(validateOpenConversationPayload(null)).toEqual({ok: false, error: '载荷非法'})
    expect(validateOpenConversationPayload('x')).toEqual({ok: false, error: '载荷非法'})
  })
  it('缺 requestId → requestId 非法', () => {
    expect(validateOpenConversationPayload(validPayload({requestId: undefined})))
      .toEqual({ok: false, error: 'requestId 非法'})
  })
  it('requestId 空串 → requestId 非法', () => {
    expect(validateOpenConversationPayload(validPayload({requestId: '  '})))
      .toEqual({ok: false, error: 'requestId 非法'})
  })
  it('conversationId 非 string → conversationId 非法', () => {
    expect(validateOpenConversationPayload(validPayload({conversationId: 123})))
      .toEqual({ok: false, error: 'conversationId 非法'})
  })
  it('conversationId 空串 → conversationId 非法', () => {
    expect(validateOpenConversationPayload(validPayload({conversationId: ''})))
      .toEqual({ok: false, error: 'conversationId 非法'})
  })
  it('workspacePath 非绝对路径 → workspacePath 非法', () => {
    expect(validateOpenConversationPayload(validPayload({workspacePath: 'relative/path'})))
      .toEqual({ok: false, error: 'workspacePath 非法'})
  })
})

describe('handleOpenConversation 校验分支', () => {
  it('载荷非法 → 返回校验错误', async () => {
    const r = await handleOpenConversation(validPayload({requestId: ''}), sender, makeDeps())
    expect(r).toEqual({ok: false, error: 'requestId 非法'})
  })
  it('发送方非法 → {ok:false, 非法发送方}', async () => {
    const r = await handleOpenConversation(validPayload(), sender, makeDeps({isAllowedSender: vi.fn(() => false)}))
    expect(r).toEqual({ok: false, error: '非法发送方'})
  })
  it('会话不属于该工作目录 → 拒绝', async () => {
    const r = await handleOpenConversation(
      validPayload({conversationId: 'conv-x'}),
      sender,
      makeDeps({listConvIdsInWorkspace: vi.fn(async () => ['conv-a'])}),
    )
    expect(r).toEqual({ok: false, error: '目标会话不属于该工作目录'})
  })
  it('主窗口不可用（null） → 拒绝', async () => {
    const r = await handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => null)}))
    expect(r).toEqual({ok: false, error: '主窗口不可用'})
  })
  it('主窗口已销毁 → 拒绝', async () => {
    const win = makeWin()
    win.isDestroyed = vi.fn(() => true)
    const r = await handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    expect(r).toEqual({ok: false, error: '主窗口不可用'})
  })
  it('主窗口未就绪 → 拒绝', async () => {
    const win = makeWin()
    win.webContents.isLoadingMainFrame = vi.fn(() => true)
    const r = await handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    expect(r).toEqual({ok: false, error: '主窗口未就绪'})
  })
})

describe('handleOpenConversation 转发与回执', () => {
  it('成功路径：send 携带 deliver 通道 + 载荷，ack ok → {ok:true} 且 focus 被调用', async () => {
    const win = makeWin()
    const promise = handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    await flushMicrotasks()
    expect(win.webContents.send).toHaveBeenCalledWith('app:open-conversation:deliver', validPayload())
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    resolveOpenConversationAck({requestId: 'req-1', ok: true})
    await expect(promise).resolves.toEqual({ok: true})
    expect(win.focus).toHaveBeenCalled()
  })

  it('最小化时先 restore，再 show + focus', async () => {
    const win = makeWin()
    win.isMinimized = vi.fn(() => true)
    const promise = handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    await flushMicrotasks()
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    resolveOpenConversationAck({requestId: 'req-1', ok: true})
    await promise
  })

  it('ack 携带失败 → resolve {ok:false, error}', async () => {
    const win = makeWin()
    const promise = handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    await flushMicrotasks()
    resolveOpenConversationAck({requestId: 'req-1', ok: false, error: '切换失败'})
    await expect(promise).resolves.toEqual({ok: false, error: '切换失败'})
  })

  it('ack 超时 → {ok:false, error:主窗口未响应}', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    const promise = handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    await vi.advanceTimersByTimeAsync(OPEN_CONVERSATION_ACK_TIMEOUT_MS + 1)
    await expect(promise).resolves.toEqual({ok: false, error: '主窗口未响应'})
  })

  it('send 同步抛出 → resolve {ok:false,主窗口未响应} 且清理定时器', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    win.webContents.send.mockImplementation(() => { throw new Error('send failed') })
    const r = await handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    expect(r).toEqual({ok: false, error: '主窗口未响应'})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('回执 requestId 不匹配 → 不 resolve（保持挂起直到超时）', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    const promise = handleOpenConversation(validPayload(), sender, makeDeps({getMainWindow: vi.fn(() => win as never)}))
    await flushMicrotasks()
    resolveOpenConversationAck({requestId: 'other', ok: true})
    // 未超时前仍挂起：timer 仍在，尚未 resolve
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(OPEN_CONVERSATION_ACK_TIMEOUT_MS + 1)
    await expect(promise).resolves.toEqual({ok: false, error: '主窗口未响应'})
  })

  // S5：同 requestId 覆盖必须结算旧 Promise，否则旧 invoke 永挂起（调用方 await 卡死）
  it('同 requestId 二次请求 → 旧 Promise 被结算为取消态，不悬挂', async () => {
    const win = makeWin()
    const deps = makeDeps({getMainWindow: vi.fn(() => win as never)})
    const p1 = handleOpenConversation(validPayload(), sender, deps)
    let settled1: unknown
    p1.then(r => { settled1 = r })
    await flushMicrotasks()

    const p2 = handleOpenConversation(validPayload(), sender, deps)
    await flushMicrotasks()
    expect(settled1).toEqual({ok: false, error: '请求已被覆盖'})

    // 新请求仍可被正常回执结算
    resolveOpenConversationAck({requestId: 'req-1', ok: true})
    await expect(p1).resolves.toEqual({ok: false, error: '请求已被覆盖'})
    await expect(p2).resolves.toEqual({ok: true})
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('同 requestId 覆盖 → 旧 timer 被清理，仅保留新请求的 timer', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    const deps = makeDeps({getMainWindow: vi.fn(() => win as never)})
    const p1 = handleOpenConversation(validPayload(), sender, deps)
    await flushMicrotasks()
    expect(vi.getTimerCount()).toBe(1)

    const p2 = handleOpenConversation(validPayload(), sender, deps)
    await flushMicrotasks()
    expect(vi.getTimerCount()).toBe(1) // 旧 timer 已清，未与新 timer 并存

    resolveOpenConversationAck({requestId: 'req-1', ok: true})
    await expect(p1).resolves.toEqual({ok: false, error: '请求已被覆盖'})
    await expect(p2).resolves.toEqual({ok: true})
    expect(vi.getTimerCount()).toBe(0)
  })
})
