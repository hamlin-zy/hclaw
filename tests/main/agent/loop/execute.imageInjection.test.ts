import {describe, it, expect} from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import {injectLoadedImages} from '../../../../src/main/agent/utils/loadImageInjection'
import {sanitizeMessagesForModel} from '../../../../src/main/agent/loop/helpers'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const TOOL_RESULT = 'image_path: /snap/abc.png\nmime: image/png\nbytes: 8\nname: a.png'

const norm = (p: string) => p.split(path.sep).join('/')

/**
 * loop 请求期注入的端到端语义（在 executeLlmCall 驱动成本过高时，按计划 Task 5 Step 4 的
 * 允许降级：以 injectLoadedImages + sanitizeMessagesForModel 的组合 + execute.ts 静态接线断言覆盖）。
 */
describe('loop 请求期图片注入', () => {
  it('静态接线：execute.ts 在 messagesToSend 构建处调用 injectLoadedImages', async () => {
    const src = await fs.readFile(
      path.resolve(process.cwd(), 'src/main/agent/loop/execute.ts'),
      'utf8',
    )
    expect(src).toContain('await injectLoadedImages(normalizedMessages)')
    expect(src).toContain('let messagesToSend: ChatMessage[] = await injectLoadedImages')
  })

  it('注入只作用于发送数组：入参 state.messages 引用与内容不被修改', async () => {
    const stateMessages = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc1', name: 'load_image', arguments: {}}]},
      {role: 'tool', toolCallId: 'tc1', functionName: 'load_image', content: '', toolResult: TOOL_RESULT},
    ] as never[]
    const snapshot = JSON.stringify(stateMessages)
    const out = await injectLoadedImages(stateMessages, async () => PNG)
    expect(out).not.toBe(stateMessages)            // 返回新数组
    expect(out.length).toBe(3)                     // 追加一条合成 user
    expect(JSON.stringify(stateMessages)).toBe(snapshot) // 原数组未被改动（R1）
    const inj = out[2] as any
    expect(inj.role).toBe('user')
    expect(inj.content[1].type).toBe('image_url')
  })

  it('非视觉/降级：sanitizeMessagesForModel 剥离注入的 image_url（请求仍可继续）', async () => {
    const stateMessages = [
      {role: 'assistant', content: '', toolCalls: [{id: 'tc1', name: 'load_image', arguments: {}}]},
      {role: 'tool', toolCallId: 'tc1', functionName: 'load_image', content: '', toolResult: TOOL_RESULT},
    ] as never[]
    const injected = await injectLoadedImages(stateMessages, async () => PNG)
    const sanitized = sanitizeMessagesForModel(injected as any)
    const stillHasImage = sanitized.some(
      m => Array.isArray(m.content) && (m.content as any[]).some(p => p.type === 'image_url'),
    )
    expect(stillHasImage).toBe(false)
  })

  it('快照路径归一为 /，无平台分隔符（缓存前缀稳定）', () => {
    expect(norm('E:\\a\\b.png')).toBe('E:/a/b.png')
  })
})
