import {describe, it, expect, beforeEach} from 'vitest'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

describe('handoffDismissed（本会话不再提醒）', () => {
  beforeEach(() => {
    useConversationStore.getState().clearHandoffDismissals()
  })
  it('默认无抑制标记', () => {
    expect(useConversationStore.getState().handoffDismissed).toEqual({})
  })
  it('dismiss 后该会话被标记', () => {
    useConversationStore.getState().dismissHandoffPrompt('conv-1')
    expect(useConversationStore.getState().handoffDismissed['conv-1']).toBe(true)
  })
  it('clear 清空全部标记（阈值调整后恢复）', () => {
    useConversationStore.getState().dismissHandoffPrompt('conv-1')
    useConversationStore.getState().dismissHandoffPrompt('conv-2')
    useConversationStore.getState().clearHandoffDismissals()
    expect(useConversationStore.getState().handoffDismissed).toEqual({})
  })
})
