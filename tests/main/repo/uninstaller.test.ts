import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {isStrictlyUnderRoot, readOriginUrl, uninstallRepo, type UninstallDeps} from '@/main/repo/uninstaller'
import type {GitRepo} from '@/main/repo/type'

let tmpDir: string
let roots: {skillsPublic: string; agents: string}
/** 主目录：skills/public/repo@source（含 .git） */
let mainDir: string

function makeGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), {recursive: true})
}

/** 写入 <dir>/.git/config 的 [remote "origin"] 段（模拟真实克隆的 origin） */
function writeOrigin(dir: string, url: string): void {
  fs.mkdirSync(path.join(dir, '.git'), {recursive: true})
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    'utf8',
  )
}

/** 主仓库（skills/public/repo@source）的 origin 常量 */
const MAIN_ORIGIN = 'https://github.com/owner/repo.git'

function makeRepo(over: Partial<GitRepo> = {}): GitRepo {
  return {
    id: 'owner/repo',
    owner: 'owner',
    name: 'repo',
    path: mainDir,
    source: 'github',
    origin: 'https://github.com/owner/repo',
    capabilities: {plugins: [], skills: [], agents: []},
    hasManifest: false,
    enabled: true,
    hasEnabledCapability: true,
    rootType: 'skill',
    ...over,
  }
}

/** 全部依赖为 spy（rm 默认成功、retryDelaysMs 为空即免等待） */
function makeDeps(repo: GitRepo | undefined, over: Partial<UninstallDeps> = {}): UninstallDeps {
  return {
    getRepo: vi.fn(() => repo),
    roots,
    rm: vi.fn(async (): Promise<void> => {}),
    deleteSkillOverrides: vi.fn(),
    deleteAgentOverrides: vi.fn(async (): Promise<void> => {}),
    dropVersionCache: vi.fn(),
    reloadCapabilities: vi.fn(async (): Promise<void> => {}),
    discoverRepos: vi.fn(async (): Promise<GitRepo[]> => []),
    broadcastMeta: vi.fn(),
    retryDelaysMs: [],
    ...over,
  }
}

/** 除 getRepo 外的副作用 spy 逐个断言「一次都没被调用」 */
const SIDE_EFFECT_KEYS = [
  'rm', 'deleteSkillOverrides', 'deleteAgentOverrides', 'dropVersionCache',
  'reloadCapabilities', 'discoverRepos', 'broadcastMeta',
] as const

function expectNoSideEffects(deps: UninstallDeps): void {
  for (const key of SIDE_EFFECT_KEYS) {
    expect(deps[key], `${key} 不应被调用`).not.toHaveBeenCalled()
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-uninstall-'))
  roots = {
    skillsPublic: path.join(tmpDir, 'skills', 'public'),
    agents: path.join(tmpDir, 'agents'),
  }
  mainDir = path.join(roots.skillsPublic, 'repo@source')
  makeGitDir(mainDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('isStrictlyUnderRoot', () => {
  it('同名前缀的兄弟目录（skills/publicX）下的路径不算位于 skills/public 之下', () => {
    const sibling = path.join(tmpDir, 'skills', 'publicX', 'repo@source')
    expect(isStrictlyUnderRoot(sibling, roots.skillsPublic)).toBe(false)
  })

  it('skills/public 的子目录算位于其下', () => {
    expect(isStrictlyUnderRoot(path.join(roots.skillsPublic, 'repo@source'), roots.skillsPublic)).toBe(true)
  })

  it('根本身不算严格位于其下', () => {
    expect(isStrictlyUnderRoot(roots.skillsPublic, roots.skillsPublic)).toBe(false)
  })

  it('上层目录不算位于其下', () => {
    expect(isStrictlyUnderRoot(tmpDir, roots.skillsPublic)).toBe(false)
  })

  it('以 .. 开头的合法子目录（..foo）算位于其下 —— 按路径段判断而非字符串前缀', () => {
    expect(isStrictlyUnderRoot(path.join(roots.skillsPublic, '..foo'), roots.skillsPublic)).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('跨盘符路径不算位于其下', () => {
    const otherDrive = path.parse(tmpDir).root.toUpperCase().startsWith('C:') ? 'D:\\' : 'C:\\'
    const crossDrive = path.join(otherDrive, 'skills', 'public', 'repo@source')
    expect(isStrictlyUnderRoot(crossDrive, roots.skillsPublic)).toBe(false)
  })
})

describe('readOriginUrl — .git/config 解析', () => {
  function readFrom(dirName: string, config?: string): string | undefined {
    const dir = path.join(tmpDir, dirName)
    fs.mkdirSync(path.join(dir, '.git'), {recursive: true})
    if (config !== undefined) fs.writeFileSync(path.join(dir, '.git', 'config'), config, 'utf8')
    return readOriginUrl(dir)
  }

  it('无 .git/config → undefined', () => {
    expect(readFrom('no-config')).toBeUndefined()
  })

  it('无 [remote "origin"] 段 → undefined', () => {
    expect(readFrom('no-origin', '[core]\n\trepositoryformatversion = 0\n')).toBeUndefined()
  })

  it('origin 段存在但无 url → undefined', () => {
    expect(readFrom('no-url', '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')).toBeUndefined()
  })

  it('取 origin 段的 url，忽略其它 remote，兼容 CRLF', () => {
    const config = '[remote "upstream"]\r\n\turl = https://github.com/other/up.git\r\n'
      + '[remote "origin"]\r\n\turl = https://github.com/owner/repo.git\r\n'
    expect(readFrom('multi-remote', config)).toBe('https://github.com/owner/repo.git')
  })

  it('url 为空值 → undefined', () => {
    expect(readFrom('empty-url', '[remote "origin"]\n\turl =   \n')).toBeUndefined()
  })
})

describe('uninstallRepo — 守卫', () => {
  it('仓库不存在 → 返回错误且所有副作用 spy 零调用', async () => {
    const deps = makeDeps(undefined)

    const result = await uninstallRepo('ghost/none', deps)

    expect(result).toEqual({success: false, error: '仓库不存在: ghost/none'})
    expectNoSideEffects(deps)
  })

  it('plugin 仓库 → 提示走插件页签，且所有副作用 spy 零调用', async () => {
    const deps = makeDeps(makeRepo({rootType: 'plugin'}))

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain('插件')
    expectNoSideEffects(deps)
  })

  it('path 不在 skillsPublic / agents 两个根之下 → 错误且零副作用', async () => {
    const outside = path.join(tmpDir, 'elsewhere', 'repo@source')
    const deps = makeDeps(makeRepo({path: outside}))

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain(outside)
    expectNoSideEffects(deps)
  })

  it('主目录不含 .git → 错误且零副作用', async () => {
    const noGit = path.join(roots.skillsPublic, 'no-git-dir')
    fs.mkdirSync(noGit, {recursive: true})
    const deps = makeDeps(makeRepo({path: noGit}))

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain(noGit)
    expectNoSideEffects(deps)
  })

  it('目录名以 .. 开头（..foo）→ 守卫放行并正常卸载', async () => {
    const dotDir = path.join(roots.skillsPublic, '..foo')
    makeGitDir(dotDir)
    const deps = makeDeps(makeRepo({path: dotDir}))

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(deps.rm).toHaveBeenCalledWith(dotDir)
  })

  it('source=local 且 id 为目录名（无 /）→ 守卫通过并正常卸载', async () => {
    const deps = makeDeps(makeRepo({
      id: 'my-local-repo',
      source: 'local',
      origin: '',
      capabilities: {plugins: [], skills: ['sk-a'], agents: []},
    }))

    const result = await uninstallRepo('my-local-repo', deps)

    expect(result.success).toBe(true)
    expect(deps.rm).toHaveBeenCalledWith(mainDir)
    expect(deps.deleteSkillOverrides).toHaveBeenCalledWith(['sk-a'])
    expect(deps.dropVersionCache).toHaveBeenCalledWith('my-local-repo')
  })
})

describe('uninstallRepo — 正常流程', () => {
  it('删主目录 → 清 override → 删缓存 → 重载能力 → 重新 discover → 广播', async () => {
    const repo = makeRepo({capabilities: {plugins: [], skills: ['sk-a', 'sk-b'], agents: ['ag-x']}})
    const deps = makeDeps(repo)

    const result = await uninstallRepo('owner/repo', deps)

    expect(deps.rm).toHaveBeenCalledTimes(1)
    expect(deps.rm).toHaveBeenCalledWith(mainDir)
    expect(deps.deleteSkillOverrides).toHaveBeenCalledTimes(1)
    expect(deps.deleteSkillOverrides).toHaveBeenCalledWith(['sk-a', 'sk-b'])
    expect(deps.deleteAgentOverrides).toHaveBeenCalledTimes(1)
    expect(deps.deleteAgentOverrides).toHaveBeenCalledWith(['ag-x'])
    expect(deps.dropVersionCache).toHaveBeenCalledTimes(1)
    expect(deps.dropVersionCache).toHaveBeenCalledWith('owner/repo')
    expect(deps.reloadCapabilities).toHaveBeenCalledTimes(1)
    expect(deps.discoverRepos).toHaveBeenCalledTimes(1)
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)

    expect(result).toEqual({success: true, removed: {skills: 2, agents: 1}})
  })
})

describe('uninstallRepo — 失败语义', () => {
  it('主目录删除失败（重试耗尽）→ 立即短路，后续副作用 spy 零调用', async () => {
    const deps = makeDeps(makeRepo(), {
      rm: vi.fn(async (): Promise<void> => { throw new Error('EBUSY') }),
    })

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain(mainDir)
    // fs.rm 是部分删除语义：不能对外承诺「磁盘零改动」，文案必须给出可操作提示
    expect(result.error).toContain('可手动清理')
    expect(result.error).toContain('重试')
    expect(deps.rm).toHaveBeenCalledTimes(1)
    expect(deps.deleteSkillOverrides).not.toHaveBeenCalled()
    expect(deps.deleteAgentOverrides).not.toHaveBeenCalled()
    expect(deps.dropVersionCache).not.toHaveBeenCalled()
    expect(deps.reloadCapabilities).not.toHaveBeenCalled()
    expect(deps.discoverRepos).not.toHaveBeenCalled()
    expect(deps.broadcastMeta).not.toHaveBeenCalled()
  })

  it('deleteSkillOverrides 抛错 → success + warnings，后续步骤照常', async () => {
    const deps = makeDeps(makeRepo({capabilities: {plugins: [], skills: ['sk-a'], agents: []}}), {
      deleteSkillOverrides: vi.fn(() => { throw new Error('db locked') }),
    })

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(result.warnings?.some(w => w.includes('技能残留') && w.includes('db locked'))).toBe(true)
    expect(deps.deleteAgentOverrides).toHaveBeenCalledTimes(1)
    expect(deps.dropVersionCache).toHaveBeenCalledTimes(1)
    expect(deps.reloadCapabilities).toHaveBeenCalledTimes(1)
    expect(deps.discoverRepos).toHaveBeenCalledTimes(1)
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)
  })

  it('deleteAgentOverrides 抛错 → success + warnings，后续步骤照常', async () => {
    const deps = makeDeps(makeRepo({capabilities: {plugins: [], skills: ['sk-a'], agents: ['ag-x']}}), {
      deleteAgentOverrides: vi.fn(async (): Promise<void> => { throw new Error('agent db locked') }),
    })

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(result.warnings?.some(w => w.includes('代理残留') && w.includes('agent db locked'))).toBe(true)
    expect(deps.dropVersionCache).toHaveBeenCalledTimes(1)
    expect(deps.reloadCapabilities).toHaveBeenCalledTimes(1)
    expect(deps.discoverRepos).toHaveBeenCalledTimes(1)
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)
  })

  it('dropVersionCache 抛错 → success + warnings，后续步骤照常', async () => {
    const deps = makeDeps(makeRepo(), {
      dropVersionCache: vi.fn(() => { throw new Error('cache boom') }),
    })

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(result.warnings?.some(w => w.includes('版本缓存') && w.includes('cache boom'))).toBe(true)
    expect(deps.reloadCapabilities).toHaveBeenCalledTimes(1)
    expect(deps.discoverRepos).toHaveBeenCalledTimes(1)
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)
  })

  it('reloadCapabilities reject → success + warnings，discover / 广播照常', async () => {
    const deps = makeDeps(makeRepo(), {
      reloadCapabilities: vi.fn(async (): Promise<void> => { throw new Error('reload boom') }),
    })

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(result.warnings?.some(w => w.includes('重载能力') && w.includes('reload boom'))).toBe(true)
    expect(deps.discoverRepos).toHaveBeenCalledTimes(1)
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)
  })

  it('discoverRepos reject → success + warnings，广播照常', async () => {
    const deps = makeDeps(makeRepo(), {
      discoverRepos: vi.fn(async (): Promise<GitRepo[]> => { throw new Error('discover boom') }),
    })

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(result.warnings?.some(w => w.includes('重新发现') && w.includes('discover boom'))).toBe(true)
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)
  })

  it('broadcastMeta 抛错 → success + warnings，不抛出', async () => {
    const deps = makeDeps(makeRepo(), {
      broadcastMeta: vi.fn(() => { throw new Error('broadcast boom') }),
    })

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(result.warnings?.some(w => w.includes('广播') && w.includes('broadcast boom'))).toBe(true)
  })
})

describe('uninstallRepo — 多副本', () => {
  it('agents 根下同名目录含 .git 且 origin 同源 → 两份都删', async () => {
    const mirror = path.join(roots.agents, path.basename(mainDir))
    writeOrigin(mainDir, MAIN_ORIGIN)
    writeOrigin(mirror, MAIN_ORIGIN)
    const deps = makeDeps(makeRepo())

    const result = await uninstallRepo('owner/repo', deps)

    expect(deps.rm).toHaveBeenCalledTimes(2)
    expect(deps.rm).toHaveBeenNthCalledWith(1, mainDir)
    expect(deps.rm).toHaveBeenNthCalledWith(2, mirror)
    expect(result.success).toBe(true)
    expect(result.warnings).toBeUndefined()
  })

  it('agents 副本删除失败 → 主体仍成功 + warnings，后续步骤照常', async () => {
    const mirror = path.join(roots.agents, path.basename(mainDir))
    writeOrigin(mainDir, MAIN_ORIGIN)
    writeOrigin(mirror, MAIN_ORIGIN)
    const rm = vi.fn(async (dir: string): Promise<void> => {
      if (dir === mirror) throw new Error('EBUSY-mirror')
    })
    const deps = makeDeps(makeRepo({capabilities: {plugins: [], skills: ['sk-a'], agents: []}}), {rm})

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(result.warnings?.some(w => w.includes(mirror))).toBe(true)
    expect(deps.deleteSkillOverrides).toHaveBeenCalledWith(['sk-a'])
    expect(deps.dropVersionCache).toHaveBeenCalledWith('owner/repo')
    expect(deps.reloadCapabilities).toHaveBeenCalledTimes(1)
    expect(deps.discoverRepos).toHaveBeenCalledTimes(1)
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)
  })
})

/**
 * 副本判定不能只看「同目录名 + 含 .git」：目录名由 repoDirName() 产生，形如
 * `${repoName}@source`，不含 owner —— alice/tool 与 bob/tool 都叫 tool@source，
 * 误删是不可逆的（列表与确认弹窗都不会告知用户）。故必须再比对 .git/config 的 origin。
 */
describe('uninstallRepo — 镜像副本同源校验（origin）', () => {
  const mirrorOf = () => path.join(roots.agents, path.basename(mainDir))

  it('同源镜像（大小写与尾部 .git 规范化后相等）→ 镜像被删', async () => {
    const mirror = mirrorOf()
    writeOrigin(mainDir, 'https://github.com/Alice/Tool.git')
    writeOrigin(mirror, 'https://github.com/alice/tool')
    const deps = makeDeps(makeRepo())

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(deps.rm).toHaveBeenCalledTimes(2)
    expect(deps.rm).toHaveBeenNthCalledWith(2, mirror)
    expect(result.warnings).toBeUndefined()
  })

  it('异源镜像（同名不同 owner）→ 跳过不删并记 warnings', async () => {
    const mirror = mirrorOf()
    writeOrigin(mainDir, 'https://github.com/alice/tool.git')
    writeOrigin(mirror, 'https://github.com/bob/tool.git')
    const deps = makeDeps(makeRepo())

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(deps.rm).toHaveBeenCalledTimes(1)
    expect(deps.rm).toHaveBeenCalledWith(mainDir)
    expect(result.warnings?.some(w => w.includes('不同源') && w.includes(mirror))).toBe(true)
    // 后续步骤照常（主目录已删，仓库事实上已移除）
    expect(deps.dropVersionCache).toHaveBeenCalledWith('owner/repo')
    expect(deps.broadcastMeta).toHaveBeenCalledTimes(1)
  })

  it('双方都无 origin（local 退化仓库）→ 视为同源，镜像照删', async () => {
    const mirror = mirrorOf()
    makeGitDir(mainDir)
    makeGitDir(mirror)
    const deps = makeDeps(makeRepo())

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(deps.rm).toHaveBeenCalledTimes(2)
    expect(deps.rm).toHaveBeenNthCalledWith(2, mirror)
    expect(result.warnings).toBeUndefined()
  })

  it('只有镜像能解析出 origin → 保守跳过并记 warnings', async () => {
    const mirror = mirrorOf()
    makeGitDir(mainDir)
    writeOrigin(mirror, 'https://github.com/bob/tool.git')
    const deps = makeDeps(makeRepo())

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(deps.rm).toHaveBeenCalledTimes(1)
    expect(result.warnings?.some(w => w.includes('不同源') && w.includes(mirror))).toBe(true)
  })

  it('只有主仓库能解析出 origin → 保守跳过并记 warnings', async () => {
    const mirror = mirrorOf()
    writeOrigin(mainDir, MAIN_ORIGIN)
    makeGitDir(mirror)
    const deps = makeDeps(makeRepo())

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(deps.rm).toHaveBeenCalledTimes(1)
    expect(result.warnings?.some(w => w.includes('不同源') && w.includes(mirror))).toBe(true)
  })
})

describe('uninstallRepo — 删除重试', () => {
  it('主目录删除前两次失败、第三次成功 → success（按 retryDelaysMs 重试）', async () => {
    let calls = 0
    const rm = vi.fn(async (): Promise<void> => {
      calls += 1
      if (calls <= 2) throw new Error('EBUSY')
    })
    const deps = makeDeps(makeRepo(), {rm, retryDelaysMs: [0, 0]})

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(true)
    expect(rm).toHaveBeenCalledTimes(3)
  })

  it('重试次数耗尽 → 返回错误', async () => {
    const rm = vi.fn(async (): Promise<void> => { throw new Error('EBUSY') })
    const deps = makeDeps(makeRepo(), {rm, retryDelaysMs: [0, 0]})

    const result = await uninstallRepo('owner/repo', deps)

    expect(result.success).toBe(false)
    expect(rm).toHaveBeenCalledTimes(3)
    expect(deps.dropVersionCache).not.toHaveBeenCalled()
  })
})

describe('uninstallRepo — 幂等', () => {
  it('重复卸载同一 id → 第二次返回守卫 1 的「仓库不存在」', async () => {
    let exists = true
    const deps = makeDeps(makeRepo(), {
      getRepo: vi.fn(() => (exists ? makeRepo() : undefined)),
    })

    const first = await uninstallRepo('owner/repo', deps)
    exists = false
    const second = await uninstallRepo('owner/repo', deps)

    expect(first.success).toBe(true)
    expect(second).toEqual({success: false, error: '仓库不存在: owner/repo'})
    expect(deps.rm).toHaveBeenCalledTimes(1)
    expect(deps.dropVersionCache).toHaveBeenCalledTimes(1)
  })
})
