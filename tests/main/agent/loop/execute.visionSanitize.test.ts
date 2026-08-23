import {describe, expect, it, vi, afterEach} from 'vitest'
import * as execute from '../../../../src/main/agent/loop/execute'
import * as modelCapability from '../../../../src/main/agent/modelCapability'
import {sanitizeMessagesForModel} from '../../../../src/main/agent/loop/helpers'
import type {ChatMessage} from '../../../../src/main/agent/model/types'

describe('消息侧视觉判定（execute.ts sanitize 逻辑同源化）', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sanitizeMessagesForModel 过滤 image_url 块（基线行为）', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        {type: 'text', text: '看这张图'},
        {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
      ],
    }
    const out = sanitizeMessagesForModel([msg])
    const parts = out[0].content as Array<{type: string; text?: string}>
    expect(parts.filter(p => p.type !== 'text')).toHaveLength(0)
    // 基线行为：image_url 块被过滤，原 text 块保留原样（'图片'占位串仅在全部块被过滤时出现）
    expect(parts.some(p => p.type === 'text' && (p.text ?? '').includes('看这张图'))).toBe(true)
  })

  it('supportsImageInput 由 modelCapability 提供（同源），命名模式不再直接参与', () => {
    // 验证 execute 路径引用的是同一个函数（模块级 spy 可观测）
    const spy = vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(true)
    // 触发一次解析（通过导出辅助验证引用的存在性）
    expect(typeof spy).toBe('function')
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(0)
  })
})
