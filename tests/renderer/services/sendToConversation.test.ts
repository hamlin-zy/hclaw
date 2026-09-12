// tests/renderer/services/sendToConversation.test.ts
// @vitest-environment jsdom
import {describe, expect, it, vi, beforeEach} from 'vitest'

const h = vi.hoisted(() => ({conv: {} as any, agent: {} as any}))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
  useConversationStore: {getState: () => h.conv},
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
  // getState 返回可注入的 h.agent；setState 直接合并进 h.agent，
  // 以便「真实 startAgent」用例用 useAgentStore.setState 注入 convAgentStates。
  useAgentStore: {
    getState: () => h.agent,
    setState: (patch: Record<string, unknown>) => { Object.assign(h.agent, patch) },
  },
}))
vi.mock('../../../src/renderer/stores/agentStore/helpers/convHelpers', () => ({
  clearAllBatches: vi.fn(),
}))

import {handleSendToConversation, registerSendToConversationListener} from '../../../src/renderer/services/sendToConversation'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import {startAgentImpl} from '../../../src/renderer/stores/agentStore/handlers/startAgent'
import {createDefaultConvData, IDLE_STATE} from '../../../src/renderer/stores/agentStore/defaultState'
import type {SendToConversationPayload} from '@shared/types/project-manager'

const payload = (over: Partial<SendToConversationPayload> = {}): SendToConversationPayload => ({
  requestId: 'r', workspacePath: '/ws', content: 'hi', title: 't', target: {kind: 'new'}, ...over,
})

beforeEach(() => {
  for (const k of Object.keys(h.conv)) delete h.conv[k]
  for (const k of Object.keys(h.agent)) delete h.agent[k]
  h.conv.currentWorkspacePath = '/ws'
  h.conv.setWorkspace = vi.fn(async () => {})
  h.conv.createConversation = vi.fn(async () => 'conv-new')
  h.conv.setActiveConversation = vi.fn(async () => {})
  h.conv.loadMessagesInitial = vi.fn(async () => {})
  h.conv.addMessageToConv = vi.fn()
  h.conv.messagesMap = {}
  h.agent.startAgent = vi.fn()
  h.agent.updateConvData = vi.fn()
  h.agent.convAgentStates = {}
  ;(window as any).electronAPI = {
    agentStatus: vi.fn(async () => ({running: false})),
    agentInjectMessage: vi.fn(async () => ({success: true})),
  }
})

describe('handleSendToConversation', () => {
  it('new：同工作区不调 setWorkspace，建会话后水合再写 user 气泡，空闲则 startAgent', async () => {
    const ack = vi.fn()
    await handleSendToConversation(payload(), ack)
    expect(h.conv.setWorkspace).not.toHaveBeenCalled()
    expect(h.conv.createConversation).toHaveBeenCalledWith('t')
    expect(h.conv.addMessageToConv).toHaveBeenCalledWith('conv-new', {role: 'user', content: 'hi'})
    expect(h.agent.startAgent).toHaveBeenCalledWith({conversationId: 'conv-new', message: 'hi', force: true})
    expect(ack).toHaveBeenCalledWith({ok: true, started: true})
  })

  it('new：工作区不同则先 setWorkspace', async () => {
    h.conv.currentWorkspacePath = '/other'
    const ack = vi.fn()
    await handleSendToConversation(payload(), ack)
    expect(h.conv.setWorkspace).toHaveBeenCalledWith('/ws')
  })

  it('竞态修复：loadMessagesInitial 先于 addMessageToConv', async () => {
    const ack = vi.fn()
    await handleSendToConversation(payload(), ack)
    expect(h.conv.loadMessagesInitial).toHaveBeenCalledWith('conv-new')
    expect(h.conv.loadMessagesInitial.mock.invocationCallOrder[0])
      .toBeLessThan(h.conv.addMessageToConv.mock.invocationCallOrder[0])
  })

  it('existing：激活目标会话；运行中 → 注入而非 startAgent', async () => {
    ;(window as any).electronAPI.agentStatus = vi.fn(async () => ({running: true}))
    const ack = vi.fn()
    await handleSendToConversation(payload({target: {kind: 'existing', conversationId: 'conv-x'}}), ack)
    expect(h.conv.setActiveConversation).toHaveBeenCalledWith('conv-x')
    expect(h.conv.addMessageToConv).toHaveBeenCalledWith('conv-x', {role: 'user', content: 'hi'})
    expect(window.electronAPI!.agentInjectMessage).toHaveBeenCalledWith({conversationId: 'conv-x', content: 'hi'})
    expect(h.agent.startAgent).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ok: true, started: true})
  })

  it('existing：注入失败 → 回退 startAgent(force) 且不写 pendingMessages，started=false', async () => {
    ;(window as any).electronAPI.agentStatus = vi.fn(async () => ({running: true}))
    ;(window as any).electronAPI.agentInjectMessage = vi.fn(async () => ({success: false}))
    // 残留 pendingMessages 不应被追加（防止依赖不存在的 loop 续跑而静默丢消息）
    h.agent.convAgentStates = {'conv-x': {pendingMessages: [{content: 'old'}]}}
    const ack = vi.fn()
    await handleSendToConversation(payload({target: {kind: 'existing', conversationId: 'conv-x'}}), ack)
    expect(h.agent.updateConvData).not.toHaveBeenCalled()
    expect(h.agent.startAgent).toHaveBeenCalledWith({conversationId: 'conv-x', message: 'hi', force: true})
    expect(ack).toHaveBeenCalledWith({ok: true, started: false})
  })

  it('渲染端 paused 残留 + 主进程非运行 ⇒ 真实 startAgent 仍启动 loop（force 旁路，防 no-op）', async () => {
    // 接上真实 startAgentImpl：updateConvData 合并进 convAgentStates，startAgent 走真实守卫
    h.agent.updateConvData = (convId: string, updates: any) => {
      const prev = h.agent.convAgentStates[convId] || createDefaultConvData()
      h.agent.convAgentStates = {...h.agent.convAgentStates, [convId]: {...prev, ...updates}}
    }
    h.agent.startAgent = (params: any) => startAgentImpl(() => {}, () => h.agent, params)
    // 渲染端残留 paused（唯一清扫/解阻塞都不复位的状态）
    useAgentStore.setState({
      convAgentStates: {'conv-new': {...createDefaultConvData(), agentState: {...IDLE_STATE, status: 'paused'}}},
    })
    ;(window as any).electronAPI.agentStatus = vi.fn(async () => ({running: false}))
    ;(window as any).electronAPI.agentStart = vi.fn(async () => ({success: true}))
    const ack = vi.fn()

    await handleSendToConversation(payload(), ack)

    expect(window.electronAPI!.agentStart).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith({ok: true, started: true})
  })

  it('渲染端 thinking 残留 + 主进程非运行 ⇒ 真实 startAgent 仍启动 loop', async () => {
    h.agent.updateConvData = (convId: string, updates: any) => {
      const prev = h.agent.convAgentStates[convId] || createDefaultConvData()
      h.agent.convAgentStates = {...h.agent.convAgentStates, [convId]: {...prev, ...updates}}
    }
    h.agent.startAgent = (params: any) => startAgentImpl(() => {}, () => h.agent, params)
    useAgentStore.setState({
      convAgentStates: {'conv-new': {...createDefaultConvData(), agentState: {...IDLE_STATE, status: 'thinking'}}},
    })
    ;(window as any).electronAPI.agentStatus = vi.fn(async () => ({running: false}))
    ;(window as any).electronAPI.agentStart = vi.fn(async () => ({success: true}))
    const ack = vi.fn()

    await handleSendToConversation(payload(), ack)

    expect(window.electronAPI!.agentStart).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith({ok: true, started: true})
  })

  it('setWorkspace 抛错 → ack {ok:false, error}', async () => {
    h.conv.currentWorkspacePath = '/other'
    h.conv.setWorkspace = vi.fn(async () => { throw new Error('boom') })
    const ack = vi.fn()
    await handleSendToConversation(payload(), ack)
    expect(ack).toHaveBeenCalledWith({ok: false, error: 'boom'})
    expect(h.conv.addMessageToConv).not.toHaveBeenCalled()
  })
})

describe('registerSendToConversationListener', () => {
  it('订阅 deliver 通道，收到投递后执行并回执，cleanup 可注销', async () => {
    const cleanup = vi.fn()
    let handler: ((payload: unknown) => void) | undefined
    ;(window as any).electronAPI = {
      receive: vi.fn((channel: string, cb: (payload: unknown) => void) => {
        expect(channel).toBe('pm:send-to-conversation:deliver')
        handler = cb
        return cleanup
      }),
      projectManager: {ackSendToConversation: vi.fn()},
      agentStatus: vi.fn(async () => ({running: false})),
    }
    const dispose = registerSendToConversationListener()
    handler!({requestId: 'req-9', workspacePath: '/ws', content: 'hi', target: {kind: 'new'}})
    await new Promise(r => setTimeout(r, 0))
    expect(h.conv.addMessageToConv).toHaveBeenCalled()
    expect(window.electronAPI!.projectManager!.ackSendToConversation)
      .toHaveBeenCalledWith({requestId: 'req-9', ok: true, started: true})
    dispose()
    expect(cleanup).toHaveBeenCalled()
  })

  it('electronAPI.receive 缺失时返回可安全调用的 cleanup', () => {
    ;(window as any).electronAPI = {}
    const dispose = registerSendToConversationListener()
    expect(() => dispose()).not.toThrow()
  })
})
