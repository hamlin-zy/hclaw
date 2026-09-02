import {describe, expect, it, vi} from 'vitest'
import * as path from 'path'
import {installTargetDir, installRepo} from '@/main/repo/installer'

// 避开 config.ts 的 TDZ 初始化问题：真实 sqlite 模块顶层调用 getHclawDir（与 registry.test.ts 一致）
vi.mock('@/main/repositories/sqlite', () => ({
  getDatabase: () => ({}),
  systemSettingsRepo: {},
  workspaceRepo: {},
}))

describe('installTargetDir', () => {
  it('skill → skills/public/<repo>@source', () => {
    const p = installTargetDir('skill', 'gsap-skills')
    expect(p.endsWith(path.join('skills', 'public', 'gsap-skills@source'))).toBe(true)
  })
  it('agent → agents/<repo>@source', () => {
    const p = installTargetDir('agent', 'myagent')
    expect(p.endsWith(path.join('agents', 'myagent@source'))).toBe(true)
  })
})

describe('installRepo', () => {
  it('非法 URL → 返回错误', async () => {
    const r = await installRepo('skill', 'junk')
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
