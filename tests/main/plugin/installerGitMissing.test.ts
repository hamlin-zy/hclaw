import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 预检固定失败（Git 未安装），其余导出保持真实实现
vi.mock('@/main/common/gitAvailability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/main/common/gitAvailability')>()
  return {...actual, checkGitAvailable: vi.fn(async () => ({available: false, reason: 'not-found'}))}
})

// 不触碰真实 git 子进程
const {cloneMock} = vi.hoisted(() => ({cloneMock: vi.fn()}))

vi.mock('simple-git', () => {
  const simpleGit = () => {
    const api: Record<string, unknown> = {}
    api.env = () => api
    api.clone = cloneMock
    return api
  }
  return {simpleGit}
})

import {GIT_NOT_INSTALLED_MESSAGE} from '@/main/common/gitAvailability'
import {PluginInstaller} from '@/main/plugin/installer'

const pluginsDir = path.join(os.tmpdir(), `hclaw-test-plugin-git-missing-${process.pid}`)

describe('PluginInstaller 在 Git 未安装时', () => {
  beforeEach(() => {
    cloneMock.mockReset()
    fs.rmSync(pluginsDir, {recursive: true, force: true})
  })

  afterAll(() => {
    fs.rmSync(pluginsDir, {recursive: true, force: true})
  })

  it('install 直接返回未安装提示，不创建目标目录', async () => {
    const installer = new PluginInstaller(pluginsDir)

    const result = await installer.install({source: 'url', url: 'https://github.com/a/b'})

    expect(result.success).toBe(false)
    expect(result.error).toMatchObject({type: 'git-clone-failed', message: GIT_NOT_INSTALLED_MESSAGE})
    expect(cloneMock).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(pluginsDir, 'b@github'))).toBe(false)
  })
})
