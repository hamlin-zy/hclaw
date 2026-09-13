import {describe, it, expect} from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'

const read = (p: string) => fs.readFile(path.resolve(process.cwd(), p), 'utf8')
const SRC = 'src/main/agent'

describe('load_image 注入结构不变量（R1）', () => {
  it('injectLoadedImages 只在 execute.ts 与 startAgentCore.ts 被调用', async () => {
    const files = await fs.readdir(path.join(SRC, 'loop'))
    const hits: string[] = []
    for (const f of files.filter(f => f.endsWith('.ts'))) {
      const s = await read(path.join(SRC, 'loop', f))
      if (s.includes('injectLoadedImages')) hits.push(f)
    }
    expect(hits.sort()).toEqual(['execute.ts'])
    expect(await read(path.join(SRC, 'startAgentCore.ts'))).toContain('injectLoadedImages')
  })

  it('controller.ts 未新增 load_image 相关的 user_message_injected 播报', async () => {
    const s = await read(path.join(SRC, 'loop', 'controller.ts'))
    // 现有 pendingInjectedMessages 路径的 yield 仍唯一；不得为 load_image 增加第二处
    expect((s.match(/type: 'user_message_injected'/g) ?? []).length).toBe(1)
  })

  it('controller.ts 不得出现 injectLoadedImages（R1：loop 侧零改动）', async () => {
    const s = await read(path.join(SRC, 'loop', 'controller.ts'))
    expect(s).not.toContain('injectLoadedImages')
  })
})
