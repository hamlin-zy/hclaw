// 守门（§5.3-4）：渲染端 preload 不得暴露任何 SQLite 写入通道（不变式 3：渲染端零落库）。
// 本测试先红（Task 8 交付时三条写入通道仍在），Task 12 转绿。
import {describe, it, expect} from 'vitest'
import {readFileSync} from 'node:fs'
import path from 'node:path'

const preloadSrc = readFileSync(path.resolve(__dirname, '../../src/preload/index.ts'), 'utf8')

describe('IPC 守门：渲染端零落库', () => {
  it('preload 不暴露 conversation-write-messages / -delta / block-delta 三条写入通道', () => {
    expect(preloadSrc).not.toMatch(/conversation-write-messages'/)
    expect(preloadSrc).not.toMatch(/conversation-write-messages-delta'/)
    expect(preloadSrc).not.toMatch(/conversation-write-block-delta'/)
  })
  it('preload 保留读取与事件订阅通道（读取不算落库）', () => {
    expect(preloadSrc).toMatch(/conversation-read-messages/)
    expect(preloadSrc).toMatch(/agent-stream/)
  })
  it('渠道 persistMessage 不再直插 INSERT INTO messages（§3.3 焊死）', () => {
    const handlerSrc = readFileSync(path.resolve(__dirname, '../../src/main/channel/messageHandler.ts'), 'utf8')
    // 含 INSERT OR REPLACE INTO messages 变体（终审 Minor 加固）
    expect(handlerSrc).not.toMatch(/INSERT( OR REPLACE)? INTO messages/)
  })
})
