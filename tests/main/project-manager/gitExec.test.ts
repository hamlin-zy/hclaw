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
