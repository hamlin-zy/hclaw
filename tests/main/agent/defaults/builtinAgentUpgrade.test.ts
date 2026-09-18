/**
 * 内置 Agent 模板升级机制测试
 *
 * 覆盖三层保证：
 *   1. 迁移按**字段语义**执行 —— 只改 fieldMapper 优先级下真正生效的别名键；
 *      存在遮蔽键时如实上报（避免"锚点命中但空转"）。
 *   2. 迁移幂等 + 锚点缺失即跳过 —— 用户改动绝不被覆盖。
 *   3. 生效校验失败则回滚 —— 不留"改了一半且未生效"的文件。
 *
 * 集成用例走 seedDefaultAgentFiles 真实临时目录（沿用 seedAgentFiles.test.ts 的隔离手法）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 隔离：seedAgentFiles → ../../config → repositories 存在循环依赖（_cachedHclawDir TDZ）。
// mock 掉 config 切断链路，getHclawDir 指向临时目录，绝不触碰真实 ~/.hclaw。
vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-upgrade-test-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})
vi.mock('../../../../src/main/hclawPaths', async () => await import('../../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

import {
    BUILTIN_TEMPLATE_MIGRATIONS,
    MANIFEST_FILENAME,
    contentHash,
    decideBuiltinTemplateUpgrade,
    loadManifest,
    runMigrations,
    splitBuiltinFrontmatter,
    verifyToolEffectiveness,
} from '../../../../src/main/agent/defaults/builtinAgentUpgrade'
import {seedDefaultAgentFiles} from '../../../../src/main/agent/defaults/seedAgentFiles'
import {getHclawDir} from '../../../../src/main/config'

let tempDir: string

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-upgrade-case-'))
})

afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true})
})

function migrate(id: string, content: string) {
    const migration = BUILTIN_TEMPLATE_MIGRATIONS.find((m) => m.id === id)
    if (!migration) throw new Error(`migration not found: ${id}`)
    return migration.apply(content)
}

// ─── 旧版内置 plan.md（修复前随版本分发的内容）──────────────
const LEGACY_PLAN_MD = `---
name: Plan Agent
description: 架构规划者 — 只读分析代码库现状与需求，设计方案权衡，产出可执行的实施计划（步骤/文件/依赖/风险/测试策略）。不修改任何代码。
whenToUse: 架构设计、实施计划制定、任务分解、方案权衡、重构规划、技术选型分析
tags: [planning, read-only, architecture, builtin, source:hclaw]
enabled: true
tools: [glob, grep, file_read]
disallowedTools: [agent, file_edit, file_write, notebook_edit, bash, browser_tool]
---

你是 HClaw 的 Plan Agent，一名软件架构与规划专家。

=== 只读模式 ===
你**严格禁止**：
- 创建、修改、删除任何文件
- 运行改变系统状态的命令
- 派发子 Agent

你的职责**仅限**探索代码库并设计实施计划。

## 计划输出格式

1. **Overview**: 功能/修复需求的简要说明

记住：你只能探索和规划。**绝不能**写、编辑或修改任何文件。
`

// ─── 当前版本模板（含 file_write 与"规划模式"正文）──────────
const CURRENT_PLAN_MD = `---
name: Plan Agent
description: 架构规划者 — 只读分析代码库现状与需求，设计方案权衡，产出可执行的实施计划（步骤/文件/依赖/风险/测试策略），并将计划落盘为规划文档。不修改任何源码。
whenToUse: 架构设计、实施计划制定、任务分解、方案权衡、重构规划、技术选型分析
tags: [planning, architecture, builtin, source:hclaw]
enabled: true
tools: [glob, grep, file_read, file_write]
disallowedTools: [agent, file_edit, bash]
---

你是 HClaw 的 Plan Agent，一名软件架构与规划专家。

=== 规划模式 ===
你的职责是探索代码库、设计方案，并把最终计划**落盘**为规划文档。
你可以并应当使用 file_write 将计划写入规划文档（如 docs/plans/<name>.md）。

你**严格禁止**：
- 修改/编辑任何源码或既有文件（无 file_edit，禁止覆盖源码）
- 运行改变系统状态的命令（无 bash）
- 派发子 Agent

## 计划输出格式

1. **Overview**: 功能/修复需求的简要说明

## 落盘要求

完成规划后，**必须**使用 file_write 将计划写入规划文档（默认 \`docs/plans/<slug>.md\`），
并在回复中给出该文件路径。不得修改或覆盖任何源码与既有文件。

记住：你只负责探索、规划，并把计划写入规划文档；**绝不能**修改或覆盖任何源码与既有文件。
`

describe('contentHash / splitBuiltinFrontmatter', () => {
    it('同一内容 hash 稳定，不同内容 hash 不同', () => {
        expect(contentHash('abc')).toBe(contentHash('abc'))
        expect(contentHash('abc')).not.toBe(contentHash('abd'))
    })

    it('拆分 frontmatter 并保留换行符风格', () => {
        const lf = splitBuiltinFrontmatter('---\nname: A\n---\nbody\n')
        expect(lf?.frontmatterText).toBe('name: A')
        expect(lf?.rest).toBe('body\n')
        expect(lf?.eol).toBe('\n')

        const crlf = splitBuiltinFrontmatter('---\r\nname: A\r\n---\r\nbody\r\n')
        expect(crlf?.eol).toBe('\r\n')
    })

    it('无 frontmatter → null', () => {
        expect(splitBuiltinFrontmatter('plain text')).toBeNull()
    })
})

describe('plan-allow-file-write — 字段语义与别名优先级', () => {
    it('只声明 tools: 时补入 file_write', () => {
        const result = migrate('plan-allow-file-write', LEGACY_PLAN_MD)
        expect(result.outcome).toBe('applied')
        expect(result.content).toContain('tools: [glob, grep, file_read, file_write]')
        expect(result.content).not.toContain('tools: [glob, grep, file_read]\n')
    })

    it('allowedTools 与 tools 并存 → 只改生效的 allowedTools，并上报被遮蔽的 tools', () => {
        const content = `---
name: Plan Agent
tags: [builtin, source:hclaw]
allowedTools: ["glob", "grep", "file_read"]
tools: [glob, grep, file_read]
---
正文
`
        const result = migrate('plan-allow-file-write', content)
        expect(result.outcome).toBe('applied')
        // 生效键被修补（保留其引号风格），遮蔽键原样不动
        expect(result.content).toContain('allowedTools: ["glob", "grep", "file_read", "file_write"]')
        expect(result.content).toContain('tools: [glob, grep, file_read]')
        expect(result.shadowedKeys).toEqual(['tools'])
    })

    it('已含 file_write → noop（幂等）', () => {
        const once = migrate('plan-allow-file-write', LEGACY_PLAN_MD)
        const twice = migrate('plan-allow-file-write', once.content)
        expect(twice.outcome).toBe('noop')
        expect(twice.content).toBe(once.content)
    })

    it('无工具白名单键 → noop（不限制工具即已满足）', () => {
        const content = `---\nname: Plan Agent\ntags: [builtin, source:hclaw]\n---\n正文\n`
        expect(migrate('plan-allow-file-write', content).outcome).toBe('noop')
    })

    it('块序列等不可解析写法 → skipped（fail-closed，不动用户文件）', () => {
        const content = `---
name: Plan Agent
tags: [builtin, source:hclaw]
tools:
  - glob
  - file_read
---
正文
`
        const result = migrate('plan-allow-file-write', content)
        expect(result.outcome).toBe('skipped')
        expect(result.content).toBe(content)
    })

    it('无 frontmatter → skipped', () => {
        expect(migrate('plan-allow-file-write', '没有 frontmatter').outcome).toBe('skipped')
    })
})

describe('plan-unblock-file-write — 黑名单解除', () => {
    it('移除 file_write 并清理不存在的 notebook_edit / browser_tool，保留其它项', () => {
        const result = migrate('plan-unblock-file-write', LEGACY_PLAN_MD)
        expect(result.outcome).toBe('applied')
        expect(result.content).toContain('disallowedTools: [agent, file_edit, bash]')
    })

    it('已满足 → noop', () => {
        const once = migrate('plan-unblock-file-write', LEGACY_PLAN_MD)
        expect(migrate('plan-unblock-file-write', once.content).outcome).toBe('noop')
    })

    it('用户自定义黑名单（未含 file_write）→ noop，不误改', () => {
        const content = `---\nname: X\ntags: [builtin, source:hclaw]\ndisallowedTools: [bash]\n---\n正文\n`
        const result = migrate('plan-unblock-file-write', content)
        expect(result.outcome).toBe('noop')
        expect(result.content).toBe(content)
    })
})

describe('explore-drop-dead-tool-names', () => {
    it('移除 notebook_edit 残留', () => {
        const content = `---\nname: Explore Agent\ntags: [builtin, source:hclaw]\ndisallowedTools: [agent, file_edit, file_write, notebook_edit]\n---\n正文\n`
        const result = migrate('explore-drop-dead-tool-names', content)
        expect(result.outcome).toBe('applied')
        expect(result.content).toContain('disallowedTools: [agent, file_edit, file_write]')
    })
})

describe('plan 正文迁移 — 锚点精确匹配', () => {
    it('只读模式段落 → 规划模式段落', () => {
        const result = migrate('plan-prompt-planning-mode', LEGACY_PLAN_MD)
        expect(result.outcome).toBe('applied')
        expect(result.content).toContain('=== 规划模式 ===')
        expect(result.content).not.toContain('=== 只读模式 ===')
    })

    it('CRLF 文件同样命中', () => {
        const crlf = LEGACY_PLAN_MD.replace(/\n/g, '\r\n')
        const result = migrate('plan-prompt-planning-mode', crlf)
        expect(result.outcome).toBe('applied')
        expect(result.content).toContain('=== 规划模式 ===')
        expect(result.content).toContain('\r\n')
        expect(result.content).not.toMatch(/[^\r]\n/)
    })

    it('用户改写过的段落 → skipped，正文原样保留', () => {
        const userEdited = LEGACY_PLAN_MD.replace('- 创建、修改、删除任何文件', '- 我自己的规则：不删文件')
        const result = migrate('plan-prompt-planning-mode', userEdited)
        expect(result.outcome).toBe('skipped')
        expect(result.content).toBe(userEdited)
    })

    it('收尾句 → 落盘要求章节', () => {
        const result = migrate('plan-prompt-plan-file-output', LEGACY_PLAN_MD)
        expect(result.outcome).toBe('applied')
        expect(result.content).toContain('## 落盘要求')
        expect(result.content).toContain('你只负责探索、规划，并把计划写入规划文档')
    })
})

describe('verifyToolEffectiveness — 镜像 filterToolsForAgent 语义', () => {
    const check = {required: ['file_write'], forbidden: []}

    it('白名单缺失（不限制）→ 通过', () => {
        expect(verifyToolEffectiveness('---\nname: A\n---\n正文\n', check).ok).toBe(true)
    })

    it('白名单含 file_write → 通过', () => {
        expect(verifyToolEffectiveness('---\nname: A\ntools: [glob, file_write]\n---\n正文\n', check).ok).toBe(true)
    })

    it('白名单不含 file_write → 失败', () => {
        const verdict = verifyToolEffectiveness('---\nname: A\ntools: [glob, grep]\n---\n正文\n', check)
        expect(verdict.ok).toBe(false)
        expect(verdict.reason).toBe('required-unavailable:file_write')
    })

    it('黑名单含 file_write → 失败（黑名单先于白名单）', () => {
        const verdict = verifyToolEffectiveness(
            '---\nname: A\ntools: [glob, file_write]\ndisallowedTools: [file_write]\n---\n正文\n',
            check,
        )
        expect(verdict.ok).toBe(false)
        expect(verdict.reason).toBe('required-unavailable:file_write')
    })

    it('别名优先级：allowedTools 生效，遮蔽的 tools 不影响判定', () => {
        const content = '---\nname: A\nallowedTools: ["glob", "file_write"]\ntools: [glob]\n---\n正文\n'
        expect(verifyToolEffectiveness(content, check).ok).toBe(true)
    })
})

describe('runMigrations / decideBuiltinTemplateUpgrade — 决策', () => {
    it('runMigrations 对旧模板套用全部适用迁移，并保持幂等', () => {
        const report = runMigrations('plan.md', LEGACY_PLAN_MD)
        expect(report.applied).toEqual([
            'plan-allow-file-write',
            'plan-unblock-file-write',
            'plan-prompt-planning-mode',
            'plan-prompt-plan-file-output',
        ])
        expect(report.skipped).toEqual([])
        expect(verifyToolEffectiveness(report.content, {required: ['file_write'], forbidden: []}).ok).toBe(true)

        const second = runMigrations('plan.md', report.content)
        expect(second.applied).toEqual([])
        expect(second.changed).toBe(false)
    })

    it('指纹命中 + 模板已变更 → 整体替换，并标记需记录 pristineHash', () => {
        const decision = decideBuiltinTemplateUpgrade('plan.md', LEGACY_PLAN_MD, CURRENT_PLAN_MD, {
            pristineHash: contentHash(LEGACY_PLAN_MD),
        })
        expect(decision.action).toBe('replace')
        expect(decision.content).toBe(CURRENT_PLAN_MD)
        expect(decision.recordPristine).toBe(true)
    })

    it('指纹命中 + 内容已是最新 → unchanged', () => {
        const decision = decideBuiltinTemplateUpgrade('plan.md', CURRENT_PLAN_MD, CURRENT_PLAN_MD, {
            pristineHash: contentHash(CURRENT_PLAN_MD),
        })
        expect(decision.action).toBe('unchanged')
    })

    it('指纹失配（用户改过）→ 只做锚点迁移，且不记录 pristineHash', () => {
        const userEdited = LEGACY_PLAN_MD + '\n## 我的私有章节\n\n用户自己加的内容\n'
        const decision = decideBuiltinTemplateUpgrade('plan.md', userEdited, CURRENT_PLAN_MD, {
            pristineHash: contentHash(LEGACY_PLAN_MD),
        })
        expect(decision.action).toBe('migrate')
        expect(decision.recordPristine).toBe(false)
        expect(decision.content).toContain('## 我的私有章节')
        expect(decision.content).toContain('file_write')
    })

    it('无 manifest 基线（老用户）→ 走锚点迁移', () => {
        const decision = decideBuiltinTemplateUpgrade('plan.md', LEGACY_PLAN_MD, CURRENT_PLAN_MD, undefined)
        expect(decision.action).toBe('migrate')
        expect(decision.recordPristine).toBe(false)
        expect(verifyToolEffectiveness(decision.content, {required: ['file_write'], forbidden: []}).ok).toBe(true)
    })

    it('用户已自行放行但仍缺 file_write → 迁移补齐后通过校验', () => {
        const partially = LEGACY_PLAN_MD.replace(
            'disallowedTools: [agent, file_edit, file_write, notebook_edit, bash, browser_tool]',
            'disallowedTools: [agent, file_edit, bash]',
        )
        const decision = decideBuiltinTemplateUpgrade('plan.md', partially, CURRENT_PLAN_MD, undefined)
        expect(decision.action).toBe('migrate')
        expect(verifyToolEffectiveness(decision.content, {required: ['file_write'], forbidden: []}).ok).toBe(true)
    })

    it('生效校验失败 → 整体回滚（action=none），不写盘', () => {
        // 用户把白名单写成不含 file_write 且迁移无法安全解析（块序列）→ 校验失败
        const hostile = `---
name: Plan Agent
tags: [planning, builtin, source:hclaw]
tools:
  - glob
  - file_read
disallowedTools: [agent, file_edit, file_write]
---
正文
`
        const decision = decideBuiltinTemplateUpgrade('plan.md', hostile, CURRENT_PLAN_MD, undefined)
        expect(decision.action).toBe('none')
        expect(decision.content).toBe(hostile)
        expect(decision.verifyFailure).toBe('required-unavailable:file_write')
        expect(decision.appliedMigrations).toEqual([])
    })
})

describe('seedDefaultAgentFiles — 老用户升级集成', () => {
    const agentsDir = path.join(getHclawDir(), 'agents')
    const planPath = path.join(agentsDir, 'plan.md')
    const manifestPath = path.join(agentsDir, MANIFEST_FILENAME)

    beforeEach(() => {
        fs.rmSync(agentsDir, {recursive: true, force: true})
    })

    it('首次播种 → 写入 manifest 基线', () => {
        seedDefaultAgentFiles()
        expect(fs.existsSync(manifestPath)).toBe(true)
        const manifest = loadManifest(manifestPath)
        expect(manifest.files['plan.md']?.pristineHash).toBe(contentHash(fs.readFileSync(planPath, 'utf-8')))
    })

    it('老用户（无 manifest + 旧模板 + 自有改动）→ 自动迁移且保留自有改动', () => {
        fs.mkdirSync(agentsDir, {recursive: true})
        const legacyWithUserEdit = LEGACY_PLAN_MD.replace(
            '## 计划输出格式',
            '## 我们的团队约定\n\n所有计划必须包含回滚方案。\n\n## 计划输出格式',
        )
        fs.writeFileSync(planPath, legacyWithUserEdit, 'utf-8')

        seedDefaultAgentFiles()

        const after = fs.readFileSync(planPath, 'utf-8')
        expect(after).toContain('## 我们的团队约定')
        expect(after).toContain('所有计划必须包含回滚方案。')
        expect(after).toContain('tools: [glob, grep, file_read, file_write]')
        expect(after).toContain('disallowedTools: [agent, file_edit, bash]')
        expect(after).toContain('=== 规划模式 ===')
        expect(verifyToolEffectiveness(after, {required: ['file_write'], forbidden: []}).ok).toBe(true)
    })

    it('迁移幂等：第二次启动不再改动文件', () => {
        fs.mkdirSync(agentsDir, {recursive: true})
        fs.writeFileSync(planPath, LEGACY_PLAN_MD, 'utf-8')

        seedDefaultAgentFiles()
        const first = fs.readFileSync(planPath, 'utf-8')
        seedDefaultAgentFiles()
        expect(fs.readFileSync(planPath, 'utf-8')).toBe(first)
    })

    it('用户自定义占用内置文件名（无 source:hclaw）→ 永不触碰', () => {
        fs.mkdirSync(agentsDir, {recursive: true})
        const custom = `---\nname: My Plan\ntags: [custom]\n---\n我的正文\n`
        fs.writeFileSync(planPath, custom, 'utf-8')
        seedDefaultAgentFiles()
        expect(fs.readFileSync(planPath, 'utf-8')).toBe(custom)
    })

    it('BOM 前缀文件迁移后保留 BOM', () => {
        fs.mkdirSync(agentsDir, {recursive: true})
        fs.writeFileSync(planPath, '\uFEFF' + LEGACY_PLAN_MD, 'utf-8')

        seedDefaultAgentFiles()

        const raw = fs.readFileSync(planPath, 'utf-8')
        expect(raw.startsWith('\uFEFF')).toBe(true)
        expect(raw).toContain('file_write')
        expect(raw).toContain('=== 规划模式 ===')
    })

    it('锚点全部失配（用户大改）→ 文件一字不动，仅记录 skipped', () => {
        fs.mkdirSync(agentsDir, {recursive: true})
        const rewritten = `---
name: Plan Agent
description: 我自己重写的规划 Agent
tags: [planning, builtin, source:hclaw]
enabled: true
tools: [glob, file_read]
disallowedTools: [bash]
---
我完全重写的正文。
`
        fs.writeFileSync(planPath, rewritten, 'utf-8')

        seedDefaultAgentFiles()

        // tools 缺 file_write → 迁移补入；但正文与黑名单锚点全部失配
        const after = fs.readFileSync(planPath, 'utf-8')
        expect(after).toContain('我完全重写的正文。')
        expect(after).toContain('description: 我自己重写的规划 Agent')
        expect(after).toContain('disallowedTools: [bash]')
        expect(after).toContain('tools: [glob, file_read, file_write]')
    })
})
