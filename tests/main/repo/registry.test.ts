import {describe, expect, it, beforeEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {RepoRegistry, repoRegistry, findRepoRoot} from '@/main/repo/registry'
import type {GitRepo} from '@/main/repo/type'

// 避开 config.ts 的 TDZ 初始化问题：真实 sqlite 模块顶层调用 getHclawDir（与 loader.test.ts 一致）
vi.mock('@/main/repositories/sqlite', () => ({
  getDatabase: () => ({}),
  systemSettingsRepo: {},
  workspaceRepo: {},
}))

function repo(id: string, rpath: string, name = id.split('/')[1]): GitRepo {
  return {
    id, owner: id.split('/')[0], name, path: rpath,
    source: 'github', origin: `https://github.com/${id}.git`,
    capabilities: {plugins: [], skills: [], agents: []},
    hasManifest: false, enabled: true,
    rootType: rpath.includes('plugins') ? 'plugin' : rpath.includes('agents') ? 'agent' : 'skill',
  }
}

const repos: GitRepo[] = [
  repo('greensock/gsap-skills', '/root/skills/public/gsap-skills@source'),
  repo('obra/superpowers', '/root/plugins/superpowers@github'),
]

describe('findRepoRoot — 向上找最近 .git 对应仓库', () => {
  it('文件在仓库根目录内 → 命中该仓库', () => {
    expect(findRepoRoot('/root/skills/public/gsap-skills@source', repos)?.id).toBe('greensock/gsap-skills')
  })
  it('多级子目录 → 向上命中仓库根', () => {
    expect(findRepoRoot('/root/skills/public/gsap-skills@source/skills/sub/dir', repos)?.id).toBe('greensock/gsap-skills')
  })
  it('找不到任何仓库 → undefined', () => {
    expect(findRepoRoot('/root/custom/my-skill', repos)).toBeUndefined()
  })
  it('目录路径等于仓库 path → 命中', () => {
    expect(findRepoRoot('/root/plugins/superpowers@github', repos)?.id).toBe('obra/superpowers')
  })
})

async function makeTmpTree(): Promise<string> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-reg-'))
  fs.mkdirSync(path.join(base, 'plugins', 'superpowers@github', '.git'), {recursive: true})
  fs.mkdirSync(path.join(base, 'skills', 'public', 'gsap-skills@source', '.git'), {recursive: true})
  fs.mkdirSync(path.join(base, 'skills', 'public', 'gsap-skills@source', 'skill1'), {recursive: true})
  fs.writeFileSync(path.join(base, 'skills', 'public', 'gsap-skills@source', 'skill1', 'SKILL.md'), '# hi')
  fs.mkdirSync(path.join(base, 'agents', 'myagent@source', '.git'), {recursive: true})
  fs.writeFileSync(path.join(base, 'agents', 'myagent@source', 'agent.md'), '# agent')
  fs.mkdirSync(path.join(base, 'custom'), {recursive: true}) // 无 .git → 应忽略
  fs.writeFileSync(path.join(base, 'plugins', 'superpowers@github', 'plugin.json'), '{"name":"superpowers"}')
  return base
}

const reader = async (dir: string) => {
  if (dir.endsWith('superpowers@github')) return {origin: 'https://github.com/obra/superpowers.git', owner: 'obra', name: 'superpowers', source: 'github' as const}
  if (dir.endsWith('gsap-skills@source')) return {origin: 'https://github.com/greensock/gsap-skills.git', owner: 'greensock', name: 'gsap-skills', source: 'github' as const}
  if (dir.endsWith('myagent@source')) return {origin: 'https://github.com/me/myagent.git', owner: 'me', name: 'myagent', source: 'github' as const}
  return null
}

describe('RepoRegistry.discover', () => {
  beforeEach(() => { repoRegistry.clear() })

  it('扫描三类目录、解析 origin、owner/repo 去重、聚合 capabilities', async () => {
    const tmp = await makeTmpTree()
    const deps = {
      roots: {plugins: path.join(tmp, 'plugins'), skillsPublic: path.join(tmp, 'skills', 'public'), agents: path.join(tmp, 'agents')},
      skills: [{id: 'gsap-skills@source:skill1', dir: path.join(tmp, 'skills', 'public', 'gsap-skills@source', 'skill1')}],
      agents: [{id: 'me/myagent:agent', filePath: path.join(tmp, 'agents', 'myagent@source', 'agent.md')}],
      plugins: [{name: 'superpowers', path: path.join(tmp, 'plugins', 'superpowers@github'), enabled: true}],
    }
    const found = await repoRegistry.discover(reader, deps)
    const ids = found.map(r => r.id).sort()
    expect(ids).toEqual(['greensock/gsap-skills', 'me/myagent', 'obra/superpowers'])
    const gsap = found.find(r => r.id === 'greensock/gsap-skills')!
    expect(gsap.capabilities.skills).toEqual(['gsap-skills@source:skill1'])
    expect(gsap.source).toBe('github')
    const agent = found.find(r => r.id === 'me/myagent')!
    expect(agent.capabilities.agents).toEqual(['me/myagent:agent'])
    const sp = found.find(r => r.id === 'obra/superpowers')!
    expect(sp.capabilities.plugins).toEqual(['superpowers'])
    expect(sp.hasManifest).toBe(true)
  })

  it('无 origin 的含 .git 目录 → source=local, id=目录名', async () => {
    const tmp = await makeTmpTree()
    const found = await repoRegistry.discover(async () => null, {
      roots: {plugins: path.join(tmp, 'plugins'), skillsPublic: path.join(tmp, 'skills', 'public'), agents: path.join(tmp, 'agents')},
    })
    expect(found.filter(r => r.source === 'local').length).toBeGreaterThanOrEqual(3)
    expect(found.every(r => r.id)).toBe(true)
  })

  it('无 .git 的目录被忽略（custom 不出现）', async () => {
    const tmp = await makeTmpTree()
    const found = await repoRegistry.discover(async () => null, {
      roots: {plugins: path.join(tmp, 'plugins'), skillsPublic: path.join(tmp, 'skills', 'public'), agents: path.join(tmp, 'agents')},
    })
    expect(found.some(r => r.path.includes(path.join('custom')))).toBe(false)
  })

  it('filePath 非 string 的 agent 被跳过，不导致 discover 崩溃', async () => {
    const tmp = await makeTmpTree()
    const deps = {
      roots: {plugins: path.join(tmp, 'plugins'), skillsPublic: path.join(tmp, 'skills', 'public'), agents: path.join(tmp, 'agents')},
      agents: [
        {id: 'cmd:echo', filePath: undefined as unknown as string}, // 命令型 agent，无文件路径
        {id: 'me/myagent:agent', filePath: path.join(tmp, 'agents', 'myagent@source', 'agent.md')},
      ],
    }
    const found = await repoRegistry.discover(reader, deps)
    const agent = found.find(r => r.id === 'me/myagent')!
    expect(agent.capabilities.agents).toEqual(['me/myagent:agent'])
    expect(found.every(r => !r.capabilities.agents.includes('cmd:echo'))).toBe(true)
  })

  it('get/getAll/getByPath 基础查询', async () => {
    const tmp = await makeTmpTree()
    await repoRegistry.discover(reader, {
      roots: {plugins: path.join(tmp, 'plugins'), skillsPublic: path.join(tmp, 'skills', 'public'), agents: path.join(tmp, 'agents')},
    })
    expect(repoRegistry.getAll().length).toBe(3)
    expect(repoRegistry.get('obra/superpowers')?.owner).toBe('obra')
    expect(repoRegistry.getByPath(path.join(tmp, 'plugins', 'superpowers@github'))?.id).toBe('obra/superpowers')
  })
})
