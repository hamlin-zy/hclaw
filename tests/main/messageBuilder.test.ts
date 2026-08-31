import {describe, it, expect} from 'vitest'
import {buildUserMessage} from '../../src/main/agent/messageBuilder'
import {messageToBlocks} from '../../src/main/repositories/sqlite/messageBlockHelper'

describe('messageBuilder.buildUserMessage（唯一构建者契约）', () => {
  it('纯文本：content 为字符串，无 attachments 字段', async () => {
    const msg = await buildUserMessage({convId: 'c1', text: 'hello'})
    expect(msg.role).toBe('user')
    expect(msg.id).toBeTruthy()
    expect(msg.timestamp).toBeGreaterThan(0)
    expect(msg.content).toBe('hello')
    expect(msg.attachments).toBeUndefined()
    expect(msg.metadata?.attachments).toBeUndefined()
  })

  it('★ P1：content 恒为纯文本 string（多模态由 convertUserHistoryMessage 读时重建）', async () => {
    const msg = await buildUserMessage({
      convId: 'c1', text: '看图',
      attachments: [{path: 'Z:/a.png', name: 'a.png'}],
    })
    expect(typeof msg.content).toBe('string')
    expect(msg.content).toBe('看图')
    expect(msg.attachments?.[0].path).toBe('Z:/a.png')
  })

  it('附件：顶层 attachments 单一形态（复用 toMessageAttachments，字段为 type）', async () => {
    const msg = await buildUserMessage({
      convId: 'c1', text: '看附件',
      attachments: [{path: 'E:/doc.pdf', name: 'doc.pdf'}],
    })
    expect(msg.attachments).toBeDefined()
    expect(msg.attachments?.[0]).toMatchObject({path: 'E:/doc.pdf', name: 'doc.pdf', type: expect.any(String), id: expect.any(String)})
  })

  it('metadata 透传（commandId/messageMetadata 等命令上下文）', async () => {
    const msg = await buildUserMessage({convId: 'c1', text: 'x', metadata: {commandId: 'cmd1', commandTemplate: '/x'}})
    expect((msg.metadata as Record<string, unknown>).commandId).toBe('cmd1')
  })
})

describe('旁路链路构建一致性（memo/handoff/channel 复用后两腿同源）', () => {
  it('memo 场景：附件消息经 messageToBlocks 后 metadata.attachments 与顶层 attachments 同源', async () => {
    const msg = await buildUserMessage({
      convId: 'm1', text: '创建会话',
      attachments: [{path: 'E:/a.png', name: 'a.png'}],
    })
    expect(typeof msg.content).toBe('string')  // P1：content 纯文本
    const {messages: [record], blocks} = messageToBlocks(msg, 'm1')
    expect(record.metadata?.attachments).toEqual(msg.attachments)
    expect(blocks).toEqual([]) // user 消息无块
  })

  it('R5：预置 id（handoff userMsgId 场景）', async () => {
    const msg = await buildUserMessage({convId: 'm2', text: 'x', id: 'msg-fixed'})
    expect(msg.id).toBe('msg-fixed')
  })
})
