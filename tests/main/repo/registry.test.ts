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
    hasManifest: false, enabled: true, hasEnabledCapability: true,
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
      skills: [{id: 'gsap-skills@source:skill1', dir: path.join(tmp, 'skills', 'public', 'gsap-skills@source', 'skill1'), enabled: true}],
      agents: [{id: 'me/myagent:agent', filePath: path.join(tmp, 'agents', 'myagent@source', 'agent.md'), enabled: true}],
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
        {id: 'cmd:echo', filePath: undefined as unknown as string, enabled: true}, // 命令型 agent，无文件路径
        {id: 'me/myagent:agent', filePath: path.join(tmp, 'agents', 'myagent@source', 'agent.md'), enabled: true},
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

describe('hasEnabledCapability — 能力全部禁用时派生 false', () => {
  beforeEach(() => { repoRegistry.clear() })

  async function tree() {
    const tmp = await makeTmpTree()
    return {
      tmp,
      roots: {
        plugins: path.join(tmp, 'plugins'),
        skillsPublic: path.join(tmp, 'skills', 'public'),
        agents: path.join(tmp, 'agents'),
      },
      skill1: path.join(tmp, 'skills', 'public', 'gsap-skills@source', 'skill1'),
      agentFile: path.join(tmp, 'agents', 'myagent@source', 'agent.md'),
      pluginPath: path.join(tmp, 'plugins', 'superpowers@github'),
    }
  }

  it('技能仓库全部禁用 → false', async () => {
    const t = await tree()
    // 仓库内另有一个「启用中」的 agent：技能仓库只按 skills 列表判定，故仍应为 false
    const gsapAgentFile = path.join(t.tmp, 'skills', 'public', 'gsap-skills@source', 'gsap-agent.md')
    const found = await repoRegistry.discover(reader, {
      roots: t.roots,
      skills: [{id: 'gsap-skills@source:skill1', dir: t.skill1, enabled: false}],
      agents: [{id: 'gsap:agent', filePath: gsapAgentFile, enabled: true}],
    })
    const gsap = found.find(r => r.id === 'greensock/gsap-skills')!
    expect(gsap.capabilities.agents).toEqual(['gsap:agent'])
    expect(gsap.hasEnabledCapability).toBe(false)
  })

  it('技能项缺 enabled 字段（undefined）→ 视为启用（方向保守：不漏红点提示）', async () => {
    const t = await tree()
    // 采集源经 (s: any) 透传时可能整段丢字段；缺字段不得被当成「已禁用」，
    // 否则仓库 hasEnabledCapability 变 false、红点被误熄灭（漏更新提示）。
    const found = await repoRegistry.discover(reader, {
      roots: t.roots,
      skills: [{id: 'gsap-skills@source:skill1', dir: t.skill1, enabled: undefined} as unknown as {id: string; dir: string; enabled: boolean}],
    })
    expect(found.find(r => r.id === 'greensock/gsap-skills')!.hasEnabledCapability).toBe(true)
  })

  it('技能仓库至少一个启用 → true', async () => {
    const t = await tree()
    const skill2 = path.join(t.tmp, 'skills', 'public', 'gsap-skills@source', 'skill2')
    fs.mkdirSync(skill2, {recursive: true})
    const found = await repoRegistry.discover(reader, {
      roots: t.roots,
      skills: [
        {id: 'gsap-skills@source:skill1', dir: t.skill1, enabled: false},
        {id: 'gsap-skills@source:skill2', dir: skill2, enabled: true},
      ],
    })
    expect(found.find(r => r.id === 'greensock/gsap-skills')!.hasEnabledCapability).toBe(true)
  })

  it('能力列表为空 → true（保守）', async () => {
    const t = await tree()
    const found = await repoRegistry.discover(reader, {roots: t.roots})
    expect(found.length).toBe(3)
    expect(found.every(r => r.hasEnabledCapability)).toBe(true)
  })

  it('agent 仓库只看 agents 列表', async () => {
    const t = await tree()
    // 仓库内另有一个「启用中」的 skill：agent 仓库只按 agents 列表判定，故仍应为 false
    const agentSkillDir = path.join(t.tmp, 'agents', 'myagent@source', 'skill-x')
    fs.mkdirSync(agentSkillDir, {recursive: true})
    const found = await repoRegistry.discover(reader, {
      roots: t.roots,
      skills: [{id: 'myagent@source:skill-x', dir: agentSkillDir, enabled: true}],
      agents: [{id: 'me/myagent:agent', filePath: t.agentFile, enabled: false}],
    })
    const agentRepo = found.find(r => r.id === 'me/myagent')!
    expect(agentRepo.rootType).toBe('agent')
    expect(agentRepo.capabilities.skills).toEqual(['myagent@source:skill-x'])
    expect(agentRepo.hasEnabledCapability).toBe(false)
  })

  it('插件仓库按自身能力列表计算', async () => {
    const t = await tree()
    const pluginSkillDir = path.join(t.pluginPath, 'skills', 'sp-skill')
    const pluginAgentFile = path.join(t.pluginPath, 'agents', 'sp-agent.md')

    const allDisabled = await repoRegistry.discover(reader, {
      roots: t.roots,
      skills: [{id: 'sp:skill', dir: pluginSkillDir, enabled: false}],
      agents: [{id: 'sp:agent', filePath: pluginAgentFile, enabled: false}],
    })
    expect(allDisabled.find(r => r.id === 'obra/superpowers')!.hasEnabledCapability).toBe(false)

    repoRegistry.clear()
    const oneEnabled = await repoRegistry.discover(reader, {
      roots: t.roots,
      skills: [{id: 'sp:skill', dir: pluginSkillDir, enabled: false}],
      agents: [{id: 'sp:agent', filePath: pluginAgentFile, enabled: true}],
    })
    expect(oneEnabled.find(r => r.id === 'obra/superpowers')!.hasEnabledCapability).toBe(true)
  })

  it('重复调用 computeCapabilities 幂等，不累积重复能力项', async () => {
    const t = await tree()
    const skills = [{id: 'gsap-skills@source:skill1', dir: t.skill1, enabled: true}]
    const agents = [{id: 'me/myagent:agent', filePath: t.agentFile, enabled: true}]
    const found = await repoRegistry.discover(reader, {roots: t.roots, skills, agents})

    // computeCapabilities 为 private（仅 discover 内部调用），此处显式触发第二次重算以验证幂等
    const computeCapabilities = (repoRegistry as unknown as {
      computeCapabilities: (
        repos: GitRepo[],
        skills: {id: string; dir: string; enabled: boolean}[],
        agents: {id: string; filePath: string; enabled: boolean}[],
        plugins: {name: string; path: string; enabled: boolean}[],
      ) => void
    }).computeCapabilities
    computeCapabilities(found, skills, agents, [])

    const gsap = found.find(r => r.id === 'greensock/gsap-skills')!
    const agentRepo = found.find(r => r.id === 'me/myagent')!
    expect(gsap.capabilities.skills).toEqual(['gsap-skills@source:skill1'])
    expect(agentRepo.capabilities.agents).toEqual(['me/myagent:agent'])
    expect(gsap.hasEnabledCapability).toBe(true)
  })
})
