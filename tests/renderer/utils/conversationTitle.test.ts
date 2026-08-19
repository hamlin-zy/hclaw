import {describe, it, expect} from 'vitest'
import {deriveConversationTitle} from '../../../src/renderer/utils/conversationTitle'

describe('deriveConversationTitle（会话标题生成规则）', () => {
  it('普通消息：去除头部空格和换行', () => {
    expect(deriveConversationTitle('  修复登录 bug  ')).toBe('修复登录 bug')
    expect(deriveConversationTitle('\n\n写一个 README\n')).toBe('写一个 README')
  })

  it('/能力 换行分隔：移除 /能力 和后面的换行，只用正文', () => {
    expect(deriveConversationTitle('/bazi-analysis\n帮我分析八字')).toBe('帮我分析八字')
    expect(deriveConversationTitle('/systematic-debugging\n\n会话标题规则优化')).toBe('会话标题规则优化')
  })

  it('/能力 空格分隔：同样剥离前缀', () => {
    expect(deriveConversationTitle('/pdf 提取这份文档的表格')).toBe('提取这份文档的表格')
  })

  it('/能力 多行正文：保留内部换行', () => {
    expect(deriveConversationTitle('/视频流水线\n做视频\n主题：宠物日常')).toBe('做视频\n主题：宠物日常')
  })

  it('仅 /能力 无正文：回退保留命令本身，不产生空标题', () => {
    expect(deriveConversationTitle('/commit-msg')).toBe('/commit-msg')
    expect(deriveConversationTitle('/commit-msg  ')).toBe('/commit-msg')
  })

  it('// 开头的普通文本：按普通消息处理（非命令）', () => {
    expect(deriveConversationTitle('// 这是一段注释')).toBe('// 这是一段注释')
  })

  it('非 / 开头但含内部换行：仅去除首尾空白', () => {
    expect(deriveConversationTitle('第一行\n第二行')).toBe('第一行\n第二行')
  })

  it('空文本不抛错', () => {
    expect(deriveConversationTitle('')).toBe('')
    expect(deriveConversationTitle('   ')).toBe('')
  })
})
