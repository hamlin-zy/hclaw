import {describe, it, expect, vi, beforeEach} from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: (...a: unknown[]) => execFileMock(...a),
  spawn: vi.fn(),
}))

import {gitExec} from '../../../src/main/project-manager/git/gitExec'

describe('gitExec 超时参数（spec §4.1）', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: Function) => cb(null, '', ''))
  })

  it('缺省超时 30s（既有调用点不受影响）', async () => {
    await gitExec('/ws', ['status'])
    expect(execFileMock.mock.calls[0][2]).toMatchObject({timeout: 30_000})
  })

  it('显式超时透传（写操作 120s）', async () => {
    await gitExec('/ws', ['push'], 120_000)
    expect(execFileMock.mock.calls[0][2]).toMatchObject({timeout: 120_000})
  })
})

describe('gitExec 中文路径不 octal-escape（根治变更列表显示 \\数字）', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: Function) => cb(null, '', ''))
  })

  it('所有调用前置 -c core.quotepath=false，且原调用方 args 原样透传', async () => {
    await gitExec('/ws', ['status', '--porcelain=v1', '-uall'])
    const args = execFileMock.mock.calls[0][1] as string[]
    // 前两项是统一注入的 -c 覆盖；其余保持调用方传入的子命令不变（不影响 status.test 的 args[0] 断言）
    expect(args.slice(0, 2)).toEqual(['-c', 'core.quotepath=false'])
    expect(args.slice(2)).toEqual(['status', '--porcelain=v1', '-uall'])
  })
})
