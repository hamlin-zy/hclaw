import {beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('@/main/repositories/sqlite', () => ({
  getDatabase: () => ({}),
  systemSettingsRepo: {},
  workspaceRepo: {},
}))

// 隔离到系统临时目录，避免触碰真实 ~/.hclaw，并让「父目录未创建」可断言
vi.mock('@/main/hclawPaths', async () => {
  const pathMod = await import('path')
  const osMod = await import('os')
  const dir = pathMod.join(osMod.tmpdir(), `hclaw-test-repo-git-missing-${process.pid}`)
  return {
    getHclawDir: () => dir,
    getHclawDataDir: () => pathMod.join(dir, 'data'),
  }
})

// 预检结果由用例控制；其余导出保持真实实现
const availability = vi.hoisted(() => ({
  result: {available: false, reason: 'not-found'} as {available: boolean; version?: string; reason?: string},
}))
vi.mock('@/main/common/gitAvailability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/main/common/gitAvailability')>()
  return {...actual, checkGitAvailable: vi.fn(async () => availability.result)}
})

// simple-git 打桩：预检失败时不应有任何 clone 调用
const gitMock = vi.hoisted(() => ({clone: vi.fn()}))
vi.mock('simple-git', () => {
  const simpleGit = () => {
    const api: Record<string, unknown> = {clone: gitMock.clone}
    api.env = () => api
    return api
  }
  return {simpleGit}
})

import {GIT_NOT_INSTALLED_MESSAGE} from '@/main/common/gitAvailability'
import {getHclawDir} from '@/main/hclawPaths'
import {installRepo, installTargetDir} from '@/main/repo/installer'

const skillsPublicDir = (): string => path.join(getHclawDir(), 'skills', 'public')

describe('installRepo 的 Git 预检', () => {
  beforeEach(() => {
    fs.rmSync(getHclawDir(), {recursive: true, force: true})
    gitMock.clone.mockReset()
    availability.result = {available: false, reason: 'not-found'}
  })

  it('预检失败 → 返回未安装提示，不创建父目录，不调用 clone', async () => {
    const repoName = 'hclaw-git-missing-probe-xyz'
    const targetDir = installTargetDir('skill', repoName)

    const result = await installRepo('skill', `owner/${repoName}`)

    expect(result.success).toBe(false)
    expect(result.error).toBe(GIT_NOT_INSTALLED_MESSAGE)
    expect(fs.existsSync(targetDir)).toBe(false)
    expect(fs.existsSync(skillsPublicDir())).toBe(false)
    expect(gitMock.clone).not.toHaveBeenCalled()
  })

  it('预检通过后 clone 失败 → 返回分类文案且不含堆栈（接线不回退）', async () => {
    availability.result = {available: true, version: 'git version 2.47.1'}
    gitMock.clone.mockRejectedValueOnce(
      new Error("Cloning into 'x'...\nfatal: repository 'x' not found\n    at runTask (x.js:1:1)"),
    )

    const result = await installRepo('skill', 'owner/hclaw-clone-failure-probe-xyz')

    expect(result.success).toBe(false)
    expect(result.error).toContain('仓库不存在')
    expect(result.error).not.toContain('    at ')
  })
})
