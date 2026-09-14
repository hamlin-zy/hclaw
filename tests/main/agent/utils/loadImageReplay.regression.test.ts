import {describe, it, expect} from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import {injectLoadedImages} from '../../../../src/main/agent/utils/loadImageInjection'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const TOOL_RESULT = 'image_path: /snap/h.png\nmime: image/png\nbytes: 8\nname: a.png'

// loop 末：assistant(toolCalls) + tool（内存态 createToolResultMessage 同形）
const loopEnd = [
  {role: 'assistant', content: '', toolCalls: [{id: 'tc1', name: 'load_image', arguments: {}}]},
  {role: 'tool', toolCallId: 'tc1', functionName: 'load_image', content: '', toolResult: TOOL_RESULT, isError: false},
]
// 重建：historyConverter 还原出的同形消息（toolResult 来自 DB 存字符串）
const rebuilt = structuredClone(loopEnd)

describe('跨轮重建 = loop 末（R2）', () => {
  it('两腿注入输出逐字节一致', async () => {
    const reader = async () => PNG
    const a = await injectLoadedImages(loopEnd as never[], reader)
    const b = await injectLoadedImages(rebuilt as never[], reader)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('注入的 data URI 只由文件字节决定（同输入恒等）', async () => {
    const r1 = await injectLoadedImages(loopEnd as never[], async () => PNG)
    const r2 = await injectLoadedImages(rebuilt as never[], async () => PNG)
    const url = (m: never[]) => (m as any[]).find((x: any) => x.role === 'user' && String(x.id).startsWith('load-image:'))
    expect(url(r1).content[1].image_url.url).toBe(url(r2).content[1].image_url.url)
  })

  it('R3：快照路径随 tool 结果持久化即可重建（无快照 → 跳过，不抛）', async () => {
    const throwing = async () => { throw new Error('cleaned') }
    const out = await injectLoadedImages(loopEnd as never[], throwing)
    expect(out.length).toBe(2)
  })

  it('静态接线：startAgentCore.ts 重建侧接入同一派生函数', async () => {
    const src = await fs.readFile(path.resolve(process.cwd(), 'src/main/agent/startAgentCore.ts'), 'utf8')
    expect(src).toContain('await injectLoadedImages(convertedMessages)')
  })
})
