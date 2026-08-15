/**
 * loader 单元测试 — 技能文件系统加载器
 *
 * 覆盖：
 * - loadSkillsFromPath：单个技能目录加载、SKILL.md 缺失跳过、frontmatter 解析失败不阻塞、
 *   enabled 默认 true
 * - loadSkillsFromDirectory：public/custom 目录枚举、返回累计数量、每轮开始 resetLoadErrors
 * - findPluginSkillDirs（经 loadSkillsFromPluginDirectory）：递归发现、黑名单/隐藏目录跳过
 *
 * Mock 策略：
 * - os：vi.mock 返回 { ...实际 os, homedir: () => testHome }，且必须同时覆盖 default 导出
 *   （loader 使用 `import os from 'os'`，若只 mock named export，default 会回落到真实 homedir，
 *   导致 loader 扫描真实用户主目录 ~/.agents/skills —— 本机实测有 28 个真实技能被意外加载）。
 * - @/main/config：重定向 getHclawDir 到 testHome 下的独立临时目录（与 permissionRule.test.ts 一致）。
 * - @/main/repositories/sqlite：getDatabase mock 为 {}，避免 config.ts 的 TDZ 初始化问题
 *   （真实 sqlite 模块顶层 import getHclawDir，在测试环境下触发 Cannot access '_cachedHclawDir'）。
 * - @/main/agent/skills/registry：mock skillRegistry，捕获 register 调用。
 * - @/main/agent/skills/extensions：scanSkillExtensions mock 为空扩展。
 * - @/main/plugin/registry：PluginRegistry.getInstance() mock，控制插件 enabled 状态。
 *
 * 注意：loadBuiltinSkills() 会加载 src/main/agent/defaults/skills 下的内置技能
 * （当前仓库固定 1 个 hclaw-sdd-tools），因此 loadSkillsFromDirectory 的返回计数
 * 为 user 技能数 + 1。相关断言按此计算。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {SkillDefinition} from '@/main/agent/skills/types'

// ─── hoisted mock 状态（必须在 vi.mock 之前提升）─────────────────

const {testHome} = vi.hoisted(() => ({
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted 工厂内无法使用 import，需 require 提前计算路径
    testHome: require('path').join(require('os').tmpdir(), 'hclaw-test-loader-' + Date.now()),
}))

const {mockRegister, mockPluginGet, mockPluginGetAll} = vi.hoisted(() => ({
    mockRegister: vi.fn(),
    mockPluginGet: vi.fn(),
    mockPluginGetAll: vi.fn(),
}))

// ─── 模块 mock ───────────────────────────────────────────────────

// loader 用 `import os from 'os'`（default import）：mock 必须同时覆盖 default，
// 否则 vitest 的 CJS interop 会把真实 os 暴露为 default（见文件头注释）。
vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>()
    const mocked = {...actual, homedir: () => testHome}
    return {...mocked, default: mocked}
})

vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- mock 工厂被提升，无法引用顶层 import 的 path
    return {getHclawDir: () => require('path').join(testHome, '.hclaw')}
})

vi.mock('@/main/repositories/sqlite', () => {
    return {getDatabase: () => ({})}
})

vi.mock('@/main/agent/skills/registry', () => ({
    skillRegistry: {register: mockRegister},
}))

vi.mock('@/main/agent/skills/extensions', () => ({
    scanSkillExtensions: async () => ({references: [], scripts: []}),
}))

vi.mock('@/main/plugin/registry', () => ({
    PluginRegistry: {
        getInstance: () => ({
            get: mockPluginGet,
            getAll: mockPluginGetAll,
            getDisabledNames: () => new Set<string>(),
        }),
    },
}))

// ─── 被测模块 ────────────────────────────────────────────────────

import {
    getAndClearLoadErrors,
    loadFromPlugin,
    loadSkillsFromDirectory,
    loadSkillsFromPluginDirectory,
} from '@/main/agent/skills/loader'

// ─── 工具函数 ────────────────────────────────────────────────────

/** 获取已注册技能的 SkillDefinition 列表 */
function registeredSkills(): SkillDefinition[] {
    return mockRegister.mock.calls.map(c => c[0] as SkillDefinition)
}

/** 创建技能目录并写入 SKILL.md */
async function writeSkill(skillDir: string, frontmatter: Record<string, unknown>, body = '# Body'): Promise<void> {
    const yamlLines = Object.entries(frontmatter)
        .map(([k, v]) => {
            if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`
            return `${k}: ${JSON.stringify(v)}`
        })
        .join('\n')
    await fs.mkdir(skillDir, {recursive: true})
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\n${yamlLines}\n---\n\n${body}`, 'utf-8')
}

// 内置技能固定加载 1 个（src/main/agent/defaults/skills/hclaw-sdd-tools）
const BUILTIN_COUNT = 1

describe('loadSkillsFromPath — 技能目录加载', () => {
    let skillsDir: string

    beforeEach(async () => {
        mockRegister.mockClear()
        skillsDir = path.join(testHome, '.hclaw', 'skills')
        await fs.mkdir(path.join(skillsDir, 'public'), {recursive: true})
        await fs.mkdir(path.join(skillsDir, 'custom'), {recursive: true})
    })

    afterEach(async () => {
        await fs.rm(testHome, {recursive: true, force: true})
    })

    it('加载单个技能目录：解析 frontmatter 并注册正确的 skill 对象', async () => {
        await writeSkill(path.join(skillsDir, 'public', 'test-skill'), {
            name: 'Test Skill',
            description: 'A test skill',
            version: '2.3.4',
        })

        const count = await loadSkillsFromDirectory(skillsDir)

        // 1 个 user 技能 + 1 个内置
        expect(count).toBe(1 + BUILTIN_COUNT)
        const skill = registeredSkills().find(s => s.id === 'test-skill')
        expect(skill).toBeDefined()
        expect(skill).toMatchObject({
            id: 'test-skill',
            name: 'Test Skill',
            description: 'A test skill',
            version: '2.3.4',
            enabled: true,
            source: 'user',
        })
        expect(skill!.skillDir).toBe(path.join(skillsDir, 'public', 'test-skill'))
        expect(skill!.filePath).toBe(path.join(skillsDir, 'public', 'test-skill', 'SKILL.md'))
        expect(skill!.content).toContain('# Body')
        expect(skill!.loadedAt).toBeTypeOf('number')
    })

    it('SKILL.md 缺失的目录被跳过，不注册', async () => {
        await fs.mkdir(path.join(skillsDir, 'public', 'empty-dir'), {recursive: true})

        const count = await loadSkillsFromDirectory(skillsDir)

        // 无 user 技能，仅内置
        expect(count).toBe(BUILTIN_COUNT)
        expect(registeredSkills().some(s => s.id === 'empty-dir')).toBe(false)
    })

    it('frontmatter 解析失败不阻塞：坏技能跳过并收集错误，好技能正常加载', async () => {
        // 坏技能：YAML 语法错误
        await fs.mkdir(path.join(skillsDir, 'public', 'bad-skill'), {recursive: true})
        await fs.writeFile(
            path.join(skillsDir, 'public', 'bad-skill', 'SKILL.md'),
            '---\nname: [unclosed\n---\n',
            'utf-8',
        )
        // 好技能
        await writeSkill(path.join(skillsDir, 'public', 'good-skill'), {name: 'Good Skill'})

        const count = await loadSkillsFromDirectory(skillsDir)

        // 1 个 user（good-skill）+ 1 个内置
        expect(count).toBe(1 + BUILTIN_COUNT)
        const ids = registeredSkills().map(s => s.id)
        expect(ids).toContain('good-skill')
        expect(ids).not.toContain('bad-skill')

        // 错误被收集（YAML 解析错误 + 解析返回 null 的错误）
        const errors = getAndClearLoadErrors()
        expect(errors.length).toBeGreaterThanOrEqual(2)
        expect(errors.some(e => e.error.includes('YAML 解析错误'))).toBe(true)
    })

    it('SKILL.md 无 enabled 字段时默认 enabled=true', async () => {
        await writeSkill(path.join(skillsDir, 'public', 'no-enabled'), {
            name: 'No Enabled Flag',
        })

        await loadSkillsFromDirectory(skillsDir)

        const skill = registeredSkills().find(s => s.id === 'no-enabled')
        expect(skill).toBeDefined()
        expect(skill!.enabled).toBe(true)
    })

    it('enabled: false 被正确解析', async () => {
        await writeSkill(path.join(skillsDir, 'public', 'disabled-skill'), {
            name: 'Disabled Skill',
            enabled: false,
        })

        await loadSkillsFromDirectory(skillsDir)

        const skill = registeredSkills().find(s => s.id === 'disabled-skill')
        expect(skill).toBeDefined()
        expect(skill!.enabled).toBe(false)
    })

    it('嵌套目录递归发现，skillId 用相对路径转换', async () => {
        await writeSkill(path.join(skillsDir, 'public', 'nested', 'deep-skill'), {
            name: 'Deep Skill',
        })

        await loadSkillsFromDirectory(skillsDir)

        const skill = registeredSkills().find(s => s.id === 'nested-deep-skill')
        expect(skill).toBeDefined()
        expect(skill!.source).toBe('user')
    })
})

describe('loadSkillsFromDirectory — 目录枚举与累计', () => {
    let skillsDir: string

    beforeEach(async () => {
        mockRegister.mockClear()
        skillsDir = path.join(testHome, '.hclaw', 'skills')
        await fs.mkdir(path.join(skillsDir, 'public'), {recursive: true})
        await fs.mkdir(path.join(skillsDir, 'custom'), {recursive: true})
    })

    afterEach(async () => {
        await fs.rm(testHome, {recursive: true, force: true})
    })

    it('枚举 public/ 和 custom/ 两个目录下的技能', async () => {
        await writeSkill(path.join(skillsDir, 'public', 'skill-a'), {name: 'Skill A'})
        await writeSkill(path.join(skillsDir, 'custom', 'skill-b'), {name: 'Skill B'})

        const count = await loadSkillsFromDirectory(skillsDir)

        // 2 个 user + 1 个内置
        expect(count).toBe(2 + BUILTIN_COUNT)
        const userSkills = registeredSkills().filter(s => s.source === 'user')
        expect(userSkills.map(s => s.id).sort()).toEqual(['skill-a', 'skill-b'])
        // 两个技能 source 都是 user
        for (const s of userSkills) {
            expect(s.source).toBe('user')
        }
    })

    it('返回累计数量：public + custom + ~/.agents/skills 全部累计', async () => {
        // public 2 个 + custom 1 个 + home (~/.agents/skills) 1 个
        await writeSkill(path.join(skillsDir, 'public', 'skill-a'), {name: 'Skill A'})
        await writeSkill(path.join(skillsDir, 'public', 'skill-b'), {name: 'Skill B'})
        await writeSkill(path.join(skillsDir, 'custom', 'skill-c'), {name: 'Skill C'})
        const homeSkillsDir = path.join(testHome, '.agents', 'skills')
        await writeSkill(path.join(homeSkillsDir, 'skill-d'), {name: 'Skill D'})

        const count = await loadSkillsFromDirectory(skillsDir)

        // 4 个 user + 1 个内置
        expect(count).toBe(4 + BUILTIN_COUNT)
        const userSkills = registeredSkills().filter(s => s.source === 'user')
        expect(userSkills.map(s => s.id).sort()).toEqual(['skill-a', 'skill-b', 'skill-c', 'skill-d'])
    })

    it('custom/ 或 public/ 不存在时跳过对应分支', async () => {
        await fs.rm(path.join(skillsDir, 'custom'), {recursive: true, force: true})
        await writeSkill(path.join(skillsDir, 'public', 'skill-a'), {name: 'Skill A'})

        const count = await loadSkillsFromDirectory(skillsDir)

        // 1 个 user + 1 个内置
        expect(count).toBe(1 + BUILTIN_COUNT)
        const userSkills = registeredSkills().filter(s => s.source === 'user')
        expect(userSkills.map(s => s.id)).toEqual(['skill-a'])
    })
})

describe('loadSkillsFromDirectory — 错误收集复位', () => {
    let skillsDir: string

    beforeEach(async () => {
        mockRegister.mockClear()
        skillsDir = path.join(testHome, '.hclaw', 'skills')
        await fs.mkdir(path.join(skillsDir, 'public'), {recursive: true})
        await fs.mkdir(path.join(skillsDir, 'custom'), {recursive: true})
    })

    afterEach(async () => {
        await fs.rm(testHome, {recursive: true, force: true})
    })

    it('每轮扫描开始前 resetLoadErrors，错误不会跨轮累计', async () => {
        // 第一轮：坏技能产生 1 个错误
        await fs.mkdir(path.join(skillsDir, 'public', 'bad-skill'), {recursive: true})
        await fs.writeFile(
            path.join(skillsDir, 'public', 'bad-skill', 'SKILL.md'),
            '---\nname: [unclosed\n---\n',
            'utf-8',
        )
        await loadSkillsFromDirectory(skillsDir)
        const firstRound = getAndClearLoadErrors()
        expect(firstRound.length).toBeGreaterThanOrEqual(2)

        // 第二轮：同一坏技能仍在。若 reset 未被调用，错误会累计成两倍；
        // 实际每轮开头 reset，因此第二轮仍只有本轮的 2 个错误。
        await loadSkillsFromDirectory(skillsDir)
        const secondRound = getAndClearLoadErrors()
        expect(secondRound.length).toBe(firstRound.length)
        expect(secondRound.length).toBeGreaterThanOrEqual(2)

        // 第三轮：移除坏技能后无错误 → 若 reset 未生效，旧错误会残留；实际为空
        await fs.rm(path.join(skillsDir, 'public', 'bad-skill'), {recursive: true, force: true})
        await loadSkillsFromDirectory(skillsDir)
        const thirdRound = getAndClearLoadErrors()
        expect(thirdRound).toEqual([])
    })
})

describe('findPluginSkillDirs（经 loadSkillsFromPluginDirectory）— 插件技能发现', () => {
    let pluginDir: string

    beforeEach(() => {
        mockRegister.mockClear()
        mockPluginGet.mockReset()
        mockPluginGetAll.mockReset()
        pluginDir = path.join(testHome, 'plugins', 'test-plugin')
    })

    afterEach(async () => {
        await fs.rm(testHome, {recursive: true, force: true})
    })

    it('递归发现嵌套技能目录，跳过黑名单目录（docs）', async () => {
        // 插件根 → skills/skill-a（技能目录）
        await writeSkill(path.join(pluginDir, 'skills', 'skill-a'), {name: 'Skill A'})
        // 深层嵌套 → sub/dir/skill-b（技能目录）
        await writeSkill(path.join(pluginDir, 'sub', 'dir', 'skill-b'), {name: 'Skill B'})
        // 黑名单 docs/ → 应跳过
        await writeSkill(path.join(pluginDir, 'docs', 'skill-x'), {name: 'Skill X'})

        mockPluginGet.mockReturnValue({path: pluginDir, name: 'test-plugin', enabled: true})

        const count = await loadSkillsFromPluginDirectory('test-plugin')

        // 只发现 2 个技能目录（docs 被跳过）
        expect(count).toBe(2)
        const ids = registeredSkills().map(s => s.id).sort()
        expect(ids).toEqual(['test-plugin:skill-a', 'test-plugin:skill-b'])
        // 插件技能 source='plugin'
        for (const s of registeredSkills()) {
            expect(s.source).toBe('plugin')
            expect(s.pluginName).toBe('test-plugin')
            expect(s.pluginEnabled).toBe(true)
        }
    })

    it('黑名单目录 tests/ 直接含 SKILL.md 也被跳过', async () => {
        await writeSkill(path.join(pluginDir, 'tests'), {name: 'Test Skill'})

        mockPluginGet.mockReturnValue({path: pluginDir, name: 'test-plugin', enabled: true})

        const count = await loadSkillsFromPluginDirectory('test-plugin')
        expect(count).toBe(0)
        expect(registeredSkills()).toHaveLength(0)
    })

    it('隐藏目录（点开头）被跳过', async () => {
        await writeSkill(path.join(pluginDir, '.hidden'), {name: 'Hidden Skill'})

        mockPluginGet.mockReturnValue({path: pluginDir, name: 'test-plugin', enabled: true})

        const count = await loadSkillsFromPluginDirectory('test-plugin')
        expect(count).toBe(0)
        expect(registeredSkills()).toHaveLength(0)
    })

    it('插件未在 PluginRegistry 注册时返回 0', async () => {
        await writeSkill(path.join(pluginDir, 'skills', 'skill-a'), {name: 'Skill A'})

        mockPluginGet.mockReturnValue(undefined)

        const count = await loadSkillsFromPluginDirectory('test-plugin')
        expect(count).toBe(0)
    })

    it('插件技能 enabled 跟随插件启用状态', async () => {
        await writeSkill(path.join(pluginDir, 'skills', 'skill-a'), {name: 'Skill A'})

        // 插件被禁用
        mockPluginGet.mockReturnValue({path: pluginDir, name: 'test-plugin', enabled: false})

        const count = await loadSkillsFromPluginDirectory('test-plugin')
        expect(count).toBe(1)
        const skill = registeredSkills()[0]!
        expect(skill.id).toBe('test-plugin:skill-a')
        expect(skill.enabled).toBe(false)
        expect(skill.pluginEnabled).toBe(false)
    })

    it('loadFromPlugin 只加载指定技能目录', async () => {
        await writeSkill(path.join(pluginDir, 'skills', 'skill-a'), {name: 'Skill A'})
        await writeSkill(path.join(pluginDir, 'skills', 'skill-b'), {name: 'Skill B'})

        mockPluginGet.mockReturnValue({path: pluginDir, name: 'test-plugin', enabled: true})

        const count = await loadFromPlugin(pluginDir, 'skill-a')
        expect(count).toBe(1)
        expect(registeredSkills().map(s => s.id)).toEqual(['test-plugin:skill-a'])

        // 不存在的技能名 → 0
        const missing = await loadFromPlugin(pluginDir, 'no-such-skill')
        expect(missing).toBe(0)
    })
})
