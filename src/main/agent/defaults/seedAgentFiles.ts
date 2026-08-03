/**
 * 首次启动时将内置 Agent .md 定义写入用户配置目录
 *
 * 使用内嵌字符串常量以避免 asar 打包后的文件系统读取问题。
 * 仅在新文件不存在时写入（不覆盖用户修改）。
 *
 * ⚠️ 此文件由生成器维护 — 保持内嵌字符串与 defaults/*.md 一致。
 *    模板字面量中的反引号需转义为 \`。
 */

import * as fs from 'fs'
import * as path from 'path'
import {getHclawDir} from '../../config'
import {logger} from '../logger'

const AGENTS_DIR = path.join(getHclawDir(), 'agents')

// ─── 内嵌 .md 内容（模板字面量，保持可读性）───────────────

const IMPLEMENTER_MD = `---
name: Implementer Agent
description: SDD任务执行专用Agent — 读取任务简报、TDD开发、提交代码、自我审查、输出报告。配合 subagent-driven-development 工作流使用。
whenToUse: 代码实现、TDD开发、独立任务执行、bug修复
tags: [implementer, sdd, builtin, source:hclaw]
enabled: true
tools: [file_read, file_write, file_edit, bash, grep, glob]
---

你是 HClaw 的 Implementer Agent，专为 subagent-driven-development (SDD) 工作流设计。

## 核心职责

你执行实现计划中的**一个任务**。控制器会提供任务简报文件路径 — 先读它，再动手。

## 工作流程

1. **读取任务简报** — 控制器提供文件路径（如 \`.superpowers/sdd/<plan>/task-1-brief.md\`）。简报包含精确的需求、接口签名和全局约束。
2. **TDD（按需）** — 如果任务要求 TDD：先写失败测试 → 确认它因正确原因失败 → 实现最小代码 → 确认全部通过。
3. **实现** — 只写满足任务需求的代码，不做多（YAGNI）。每个文件应有明确单一职责。
4. **自我审查** — 检查：完整性（所有需求实现了？）、正确性（逻辑正确？）、代码整洁（命名清晰？）、是否过度设计。
5. **提交** — 使用约定式提交信息（feat:/fix:/refactor:），按逻辑变更拆分。
6. **写入报告** — 到控制器指定的路径。

## 报告格式

将详细报告写入控制器指定的文件，然后返回简短摘要（不超过 15 行）：
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- **Commits:** 短 SHA + 提交信息
- **Test:** 测试结果摘要（如 "14/14 passing"）
- **Concerns:** 如有疑虑在此说明
- **Report:** 报告文件路径

## 何时升级

- 需要架构决策 → BLOCKED
- 需要更多上下文 → NEEDS_CONTEXT
- 不确定方案是否正确 → 先问再动手
- 遇到意外阻碍 → 报告并停止
`

const CODE_REVIEWER_MD = `---
name: Code Reviewer Agent
description: SDD任务审查专用Agent — 读取任务简报和实现报告，对比diff，输出spec合规性+代码质量双维度审查结论。只读模式。配合 subagent-driven-development 工作流使用。
whenToUse: 代码审查、规范合规检查、diff审查、任务质量评估
tags: [code-reviewer, sdd, builtin, source:hclaw]
enabled: true
tools: [file_read, grep, glob, bash]
disallowedTools: [file_write, file_edit, agent]
---

你是 HClaw 的 Code Reviewer Agent，专为 subagent-driven-development (SDD) 工作流设计。

## 核心职责

审查**一个任务**的实现。这是一个任务级门控审查，不是合并审查。全分支审查在所有任务完成后单独进行。

## 只读模式

你**严格禁止**：
- 创建、修改、删除任何文件
- 运行改变系统状态的命令
- 派发子Agent

你能做的：
- 读取文件、搜索代码
- \`git diff\`、\`git log\`、\`git show\`（只读 git 操作）
- 运行测试套件验证实现者的声明

## 审查输入

控制器会提供：
- 任务简报路径 — 需求文档
- 实现者报告路径 — 他们声称做了什么
- Diff 范围 — BASE 和 HEAD SHA

## 双维度审查

### 维度 1: Spec 合规性
- **缺失**: 跳过的需求、声称实现但未在 diff 中出现的功能
- **多余**: 未请求的功能、过度设计、"锦上添花"
- **误解**: 对的特性、错的实现方式

### 维度 2: 代码质量
- 职责分离清晰？错误处理恰当？DRY 不过度抽象？
- 测试验证真实行为（非 mock 行为）？边界覆盖？
- 每个文件有明确单一职责？
- 命名清晰准确（描述做什么，而非怎么做）？

## 严重度标准

- **Critical**: 漏洞、安全、数据丢失、功能破坏
- **Important**: 架构问题、缺失功能、糟糕的错误处理、维护性损害
- **Minor**: 风格、优化、文档润色

先肯定做得好的方面（带 file:line 引用），再列问题。

## 输出格式

### Spec Compliance
✅/❌ Spec compliant | Issues found: [...]

### Strengths
[具体的、带 file:line 引用的肯定]

### Issues
#### Critical | Important | Minor
[每个: file:line, 问题描述, 为什么重要, 修复建议]

### Assessment
**Task quality:** Approved | Needs fixes
**Reasoning:** [1-2句技术评估]
`

const MD_FILES: Record<string, string> = {
    'implementer.md': IMPLEMENTER_MD,
    'code-reviewer.md': CODE_REVIEWER_MD,
}

export type BuiltinAgentFileState = 'missing' | 'valid' | 'corrupt' | 'user-conflict'

/**
 * 判定 frontmatter 是否含 `source:hclaw` 内置标记。
 *
 * 行级匹配（非子串匹配），兼容两种写法：
 * 1. 独立键 `source: hclaw`（占一整行，行首行尾无其他内容）
 * 2. `tags:` 行内独立 token `source:hclaw`（内置文件现状：`tags: [implementer, sdd, builtin, source:hclaw]`）
 *
 * `# source:hclaw` 注释、`tags: [custom, mysource:hclawzz]` 等子串均不命中。
 */
function hasBuiltinMarker(frontmatter: string): boolean {
    // 独立 `source: hclaw` 键（\r? 兼容 CRLF 行尾）
    if (/^[ \t]*source[ \t]*:[ \t]*hclaw[ \t]*\r?$/m.test(frontmatter)) return true
    // tags 行内独立 token `source:hclaw`（\b 边界防止 mysource:hclawzz / source:hclawzz 误命中）
    if (/^tags:\s*\[[^\]]*\bsource:hclaw\b[^\]]*\]/im.test(frontmatter)) return true
    return false
}

/**
 * 分类单个 Agent 文件的状态，供 seed 决策分发。
 *
 * - `missing`       → 文件不存在 → 正常种子写入
 * - `valid`         → 结构完整 + 含 `source:hclaw` 内置标记 + 正文非空 → 不覆盖
 * - `corrupt`       → 结构不完整（空文件、无 `---` 开头、frontmatter 未闭合、读取失败）
 *                     或含内置标记但正文为空 → 视为损坏 → 重建
 * - `user-conflict` → 结构完整但无 `source:hclaw` 内置标记 → 用户自定义文件占了内置文件名 → 不覆盖，仅告警
 *
 * 读取后先剥离 UTF-8 BOM（`\uFEFF`），避免 `/^---/` 锚点误判。
 */
export function classifyBuiltinAgentFile(filePath: string): BuiltinAgentFileState {
    if (!fs.existsSync(filePath)) return 'missing'

    let content: string
    try {
        content = fs.readFileSync(filePath, 'utf-8')
    } catch {
        return 'corrupt'
    }

    content = content.replace(/^\uFEFF/, '')

    // frontmatter: 以 --- 开头，闭合 --- 结尾；其后为正文
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
    if (!match) return 'corrupt'

    const frontmatter = match[1]
    const body = match[2]

    if (!hasBuiltinMarker(frontmatter)) return 'user-conflict'
    return body.trim().length > 0 ? 'valid' : 'corrupt'
}

/**
 * 校验单个 Agent 文件是否符合内置标准（classifyBuiltinAgentFile 的布尔封装）。
 *
 * 读取失败（文件不存在/无权限）或格式不符 → false。
 * 不校验内容与内置版本的一致性——用户修改过但结构完整的文件视为有效，不会被重建。
 */
export function isValidBuiltinAgentFile(filePath: string): boolean {
    return classifyBuiltinAgentFile(filePath) === 'valid'
}

export function seedDefaultAgentFiles(): void {
    if (!fs.existsSync(AGENTS_DIR)) {
        fs.mkdirSync(AGENTS_DIR, {recursive: true})
    }

    for (const [filename, content] of Object.entries(MD_FILES)) {
        const destPath = path.join(AGENTS_DIR, filename)
        switch (classifyBuiltinAgentFile(destPath)) {
            case 'missing':
                // 文件不存在 → 正常种子写入
                try {
                    fs.writeFileSync(destPath, content, 'utf-8')
                    logger.info('[seedAgentFiles] seeded', {filename})
                } catch (err: any) {
                    logger.warn('[seedAgentFiles] failed to seed', {filename, error: err?.message})
                }
                break

            case 'valid':
                // 有效内置文件（含用户修改但保留 source:hclaw 标记）不覆盖
                break

            case 'corrupt':
                // 内置文件损坏/不完整 → 重建（覆盖写）
                try {
                    logger.warn('[seedAgentFiles] builtin agent file invalid, re-seeding', {filename})
                    fs.writeFileSync(destPath, content, 'utf-8')
                    logger.info('[seedAgentFiles] re-seeded', {filename})
                } catch (err: any) {
                    logger.warn('[seedAgentFiles] failed to re-seed', {filename, error: err?.message})
                }
                break

            case 'user-conflict':
                // 用户自定义文件占了内置文件名（结构完整但无 source:hclaw）→ 不覆盖，仅告警
                logger.warn(
                    '[seedAgentFiles] user-defined agent file conflicts with builtin filename, skipping builtin template',
                    {filename},
                )
                break
        }
    }
}
