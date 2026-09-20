// gitExecResult：stdout/stderr 多字节字符跨 chunk 边界不得解成 U+FFFD（StringDecoder 兜底）
import {describe, it, expect, vi} from 'vitest'
import {EventEmitter} from 'events'
import {gitExecResult} from '../../../src/main/project-manager/git/gitExec'

const fakeSpawn = vi.hoisted(() => ({chunks: [] as Buffer[], stderrChunks: [] as Buffer[], code: 0}))

vi.mock('child_process', async () => {
  const {EventEmitter} = await import('events')
  return {
    execFile: vi.fn(),
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdin: {write: (b: Buffer) => void; end: () => void}
        kill: () => void
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = {write: vi.fn(), end: vi.fn()}
      child.kill = vi.fn()
      setImmediate(() => {
        for (const c of fakeSpawn.stderrChunks) child.stderr.emit('data', c)
        for (const c of fakeSpawn.chunks) child.stdout.emit('data', c)
        child.emit('close', fakeSpawn.code)
      })
      return child
    }),
  }
})

describe('gitExecResult UTF-8 跨 chunk 解码', () => {
  it('stdout 中的汉字被切在两个 chunk 中间仍完整，不产生 U+FFFD', async () => {
    const full = Buffer.from('中文abc', 'utf8')
    fakeSpawn.chunks = [full.subarray(0, 4), full.subarray(4)] // 4 = '中' + '文' 首字节
    fakeSpawn.stderrChunks = []
    fakeSpawn.code = 0
    const r = await gitExecResult('/ws', ['log', '--oneline'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('中文abc')
    expect(r.stdout).not.toContain('\uFFFD')
  })
})
