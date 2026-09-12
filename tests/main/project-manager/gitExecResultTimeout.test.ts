import {describe, it, expect, vi, beforeEach} from 'vitest'
import {EventEmitter} from 'events'

const spawnMock = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
  execFile: vi.fn(),
}))

import {gitExecResult} from '../../../src/main/project-manager/git/gitExec'

function makeFakeChild() {
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = {write: vi.fn(), end: vi.fn()}
  child.kill = vi.fn()
  return child
}

describe('gitExecResult 超时/错误收尾（内存泄漏审计 V2/V3）', () => {
  beforeEach(() => spawnMock.mockReset())

  it('超时后 resolve code -1（不 hang、不 reject）且 kill 子进程', async () => {
    const child = makeFakeChild()   // 永不 emit close → 模拟 git 卡死
    spawnMock.mockReturnValue(child)

    const r = await gitExecResult('/ws', ['status'], '', 50)

    expect(r).toEqual({code: -1, stdout: '', stderr: ''})
    expect(child.kill).toHaveBeenCalled()
  })

  it('error 分支 resolve -1、kill 子进程且不抛', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const p = gitExecResult('/ws', ['status'], '', 10_000)
    child.emit('error', new Error('ENOENT'))
    const r = await p

    expect(r).toEqual({code: -1, stdout: '', stderr: ''})
    expect(child.kill).toHaveBeenCalled()
  })

  it('close 分支 resolve 真实退出码', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const p = gitExecResult('/ws', ['status'], '', 10_000)
    child.emit('close', 1)
    const r = await p

    expect(r.code).toBe(1)
    expect(child.kill).toHaveBeenCalled()
  })
})
