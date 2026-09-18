// tests/renderer/services/openConversation.test.ts
// @vitest-environment jsdom
/**
 * 跨窗口「打开会话」主窗口侧执行器。
 *
 * 缺陷背景（本文件的守卫目标）：定时任务对话框跑在独立窗口，那个窗口的
 * conversationStore 从未加载会话、currentWorkspacePath 恒为 null；
 * 就地调 setActiveConversation 只改到它自己的进程 → 跳转从未生效。
 * 故必须投递给主窗口执行「切工作区 + 激活会话」，并把结果回执给主进程。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'

const h = vi.hoisted(() => ({conv: {} as any}))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
  useConversationStore: {getState: () => h.conv},
}))

import {handleOpenConversation, registerOpenConversationListener} from '../../../src/renderer/services/openConversation'
import type {OpenConversationPayload} from '@shared/types/openConversation'

const payload = (over: Partial<OpenConversationPayload> = {}): OpenConversationPayload => ({
  requestId: 'req-1',
  conversationId: 'c1',
  workspacePath: 'E:/ws',
  ...over,
})

beforeEach(() => {
  for (const k of Object.keys(h.conv)) delete h.conv[k]
  h.conv.openConversationInWorkspace = vi.fn(async () => {})
  ;(window as any).electronAPI = {}
})

describe('handleOpenConversation', () => {
  it('普通主窗口（dialogType 为空）：就地切工作区 + 激活会话，ack ok', async () => {
    const ack = vi.fn()
    await handleOpenConversation(payload(), ack)

    expect(h.conv.openConversationInWorkspace).toHaveBeenCalledWith('c1', 'E:/ws')
    expect(ack).toHaveBeenCalledWith({ok: true})
  })

  it('store 抛错 → ack {ok:false, error}', async () => {
    h.conv.openConversationInWorkspace = vi.fn(async () => { throw new Error('主窗口未响应') })
    const ack = vi.fn()
    await handleOpenConversation(payload(), ack)

    expect(ack).toHaveBeenCalledWith({ok: false, error: '主窗口未响应'})
  })

  it('配置窗口自身（dialogType 非空）不处理，直接失败回执', async () => {
    ;(window as any).electronAPI = {dialogType: 'schedules'}
    const ack = vi.fn()
    await handleOpenConversation(payload(), ack)

    expect(h.conv.openConversationInWorkspace).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ok: false, error: '本窗口不处理该操作'})
  })
})

describe('registerOpenConversationListener', () => {
  it('订阅 deliver 通道，收到投递后执行并以 app.ackOpenConversation 回执，cleanup 可注销', async () => {
    const cleanup = vi.fn()
    const ackOpenConversation = vi.fn()
    let handler: ((payload: unknown) => void) | undefined
    ;(window as any).electronAPI = {
      receive: vi.fn((channel: string, cb: (payload: unknown) => void) => {
        expect(channel).toBe('app:open-conversation:deliver')
        handler = cb
        return cleanup
      }),
      app: {ackOpenConversation},
    }

    const dispose = registerOpenConversationListener()
    handler!({requestId: 'req-9', conversationId: 'c1', workspacePath: 'E:/ws'})
    await new Promise(r => setTimeout(r, 0))

    expect(h.conv.openConversationInWorkspace).toHaveBeenCalledWith('c1', 'E:/ws')
    expect(ackOpenConversation).toHaveBeenCalledWith({requestId: 'req-9', ok: true})
    dispose()
    expect(cleanup).toHaveBeenCalled()
  })

  it('electronAPI.receive 缺失时返回可安全调用的 cleanup', () => {
    ;(window as any).electronAPI = {}
    const dispose = registerOpenConversationListener()
    expect(() => dispose()).not.toThrow()
  })
})
