# Built-in Implementer & CodeReviewer Agents + SDD Tool Mapping Skill

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Implementer and CodeReviewer agent types plus a built-in SDD tool mapping skill to HClaw, enabling superpowers' `subagent-driven-development` workflow to dispatch isolated implement/review subagents instead of falling back to inline execution.

**Architecture:** Leverage HClaw's existing two-layer agent system: (1) hardcoded `AgentTypeConfig` in `agentTypes/configs.ts` for tool restrictions + model roles, (2) filesystem `.md` definitions in `~/.hclaw/agents/` for discoverability. Add a built-in skill loading path for SDD tool mapping. All three components ship as first-run defaults — no user configuration required.

**Tech Stack:** TypeScript, Node.js, Markdown (YAML frontmatter)

## Global Constraints

- Must NOT modify any file under `C:\Users\Hamlin\.hclaw\plugins\superpowers@github\` (external plugin)
- Must NOT remove or rename existing agent types
- All new agent types must support both hardcoded fallback AND user-customizable `.md` override
- The SDD tool mapping skill must be auto-loaded on first launch for all new users
- HClaw source: `E:\workspace\media\hclaw`

---

### Task 1: Add AgentTypeConfig entries for Implementer and CodeReviewer

**Files:**
- Modify: `src/main/agent/agentTypes/configs.ts:16-69` (BUILTIN_CONFIGS array)
- Modify: `src/main/agent/agentTypes/configs.ts:145-180` (getAgentTypeDisplayInfo switch)

**Interfaces:**
- Consumes: `AgentTypeConfig` from `@shared/types` (already imported)
- Produces: Two new `AgentTypeConfig` entries registered at module init time

- [ ] **Step 1: Add Implementer config to BUILTIN_CONFIGS array**

Insert after the `Verification` entry (line 62, before `General`):

```typescript
    {
        type: 'Implementer',
        whenToUse: '代码实现、TDD开发、任务执行、bug修复',
        allowedTools: ['*'],
        defaultModelRole: 'primary',
        optimizations: {
            omitClaudeMd: true,     // 子Agent不需要项目上下文
            omitGitStatus: false,    // 需要git信息做commit
        },
    },
    {
        type: 'CodeReviewer',
        whenToUse: '代码审查、规范合规检查、代码质量评估、diff审查',
        disallowedTools: [
            'Write',
            'Edit',
            'NotebookEdit',
            'Agent',
        ],
        defaultModelRole: 'reasoning',
        optimizations: {
            omitClaudeMd: true,     // 只审查diff，无需项目上下文
            omitGitStatus: true,
        },
    },
```

- [ ] **Step 2: Update getAgentTypeDisplayInfo() switch**

Add cases before the `'General'`/`default` case at line 165:

```typescript
        case 'Implementer':
            return {
                name: 'Implementer',
                description: '代码实现 · TDD开发 · 任务执行',
                icon: '🔨',
            }
        case 'CodeReviewer':
            return {
                name: 'Code Reviewer',
                description: '代码审查 · 规范检查 · 质量评估',
                icon: '👁️',
            }
```

- [ ] **Step 3: Static verification — read file and confirm**

Run: `cat src/main/agent/agentTypes/configs.ts | Select-String -Pattern "Implementer|CodeReviewer"`
Expected: 4+ lines matching (2 config entries + 2 display info cases)

---

### Task 2: Add system prompt templates for new agent types

**Files:**
- Modify: `src/main/agent/prompts/agentTemplates.ts:217-231` (getAgentTemplate switch)
- Modify: `src/main/agent/prompts/agentTemplates.ts:237-249` (getAgentWhenToUse switch)

**Interfaces:**
- Consumes: None (templates are self-contained strings)
- Produces: `IMPLEMENTER_AGENT_TEMPLATE`, `CODE_REVIEWER_AGENT_TEMPLATE` constants; updated switch logic

- [ ] **Step 1: Add IMPLEMENTER_AGENT_TEMPLATE constant**

Insert before the `GENERAL_AGENT_TEMPLATE` definition (~line 199):

```typescript
/**
 * Implementer Agent 提示词 — SDD 任务执行专用
 *
 * 适配自 superpowers subagent-driven-development/implementer-prompt.md
 */
export const IMPLEMENTER_AGENT_TEMPLATE = `You are an Implementer for HClaw's subagent-driven development workflow.

=== YOUR JOB ===
You are executing ONE task from an implementation plan. Read your task brief FIRST
(controller will provide the file path), then implement exactly what is specified.

## Before You Begin
If you have questions about the requirements, approach, or anything unclear — ask now.

## Workflow
1. **Read the task brief** — controller provides path. It contains exact requirements.
2. **TDD when required** — write failing test → verify it fails → implement → verify it passes
3. **Implement** — minimal code that satisfies the task
4. **Self-review** — check: completeness, correctness, clean code, YAGNI compliance
5. **Commit** — conventional commit message, one per logical change
6. **Write report** — to the path provided by controller

## Rules
- Only implement what the task specifies — no extras (YAGNI)
- Each file should have one clear responsibility
- Follow existing codebase patterns
- If stuck or uncertain, escalate with BLOCKED or NEEDS_CONTEXT status
- Report format: Status (DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT), commits, test summary, concerns

## Tools
You have full access to file operations, shell commands, and git. Use them wisely.`
```

- [ ] **Step 2: Add CODE_REVIEWER_AGENT_TEMPLATE constant**

```typescript
/**
 * Code Reviewer Agent 提示词 — SDD 任务审查专用
 *
 * 适配自 superpowers subagent-driven-development/task-reviewer-prompt.md
 * 和 requesting-code-review/code-reviewer.md
 */
export const CODE_REVIEWER_AGENT_TEMPLATE = `You are a Code Reviewer for HClaw's subagent-driven development workflow.

=== YOUR JOB ===
Review ONE task's implementation against its requirements. This is a task-scoped gate,
not a merge review. A broad whole-branch review happens separately.

=== READ-ONLY MODE ===
You are STRICTLY PROHIBITED from:
- Creating, modifying, or deleting any files
- Running commands that change system state
You MAY run: git diff, git log, git show (read-only git commands)
You MAY run: test suites to verify claims in the implementer's report

## Review Inputs
Controller will provide:
- Task brief path — the requirements
- Implementer report path — what they claim they built
- Diff range — BASE and HEAD SHAs

## Part 1: Spec Compliance
Compare diff against requirements:
- **Missing:** skipped or missed requirements
- **Extra:** unrequested features, over-engineering
- **Misunderstood:** right feature, wrong implementation

## Part 2: Code Quality
- Clean separation of concerns? Proper error handling? DRY without over-abstraction?
- Tests verify real behavior (not mocks)? Edge cases covered?
- Each file has one clear responsibility?

## Calibration
Categorize by actual severity:
- **Critical:** bugs, security issues, data loss risks, broken functionality
- **Important:** architecture problems, missing features, poor error handling
- **Minor:** style, optimization, polish

Acknowledge strengths before listing issues.

## Output Format

### Spec Compliance
✅/❌ Spec compliant | Issues found: [...]

### Strengths
[Specific, file:line referenced]

### Issues
#### Critical | Important | Minor
[Each: file:line, what's wrong, why it matters, how to fix]

### Assessment
**Task quality:** Approved | Needs fixes
**Reasoning:** [1-2 sentence technical assessment]`
```

- [ ] **Step 3: Update getAgentTemplate() switch**

Add two new case branches:

```typescript
        case 'Implementer':
            return IMPLEMENTER_AGENT_TEMPLATE
        case 'CodeReviewer':
            return CODE_REVIEWER_AGENT_TEMPLATE
```

- [ ] **Step 4: Update getAgentWhenToUse() switch**

```typescript
        case 'Implementer':
            return '代码实现、TDD开发、任务执行'
        case 'CodeReviewer':
            return '代码审查、规范合规检查、代码质量评估'
```

- [ ] **Step 5: Static verification**

```bash
# Verify templates are defined
Select-String -Path "src/main/agent/prompts/agentTemplates.ts" -Pattern "IMPLEMENTER_AGENT_TEMPLATE|CODE_REVIEWER_AGENT_TEMPLATE"
```
Expected: 4 lines matching (2 constants + 2 case usages)

---

### Task 3: Create filesystem agent .md files for first-run seeding

**Files:**
- Create: `src/main/agent/defaults/implementer.md`
- Create: `src/main/agent/defaults/code-reviewer.md`
- Create: `src/main/agent/defaults/seedAgentFiles.ts`

**Interfaces:**
- Consumes: `getHclawDir()` from `../config`
- Produces: Agent `.md` files in `~/.hclaw/agents/` on first launch

- [ ] **Step 1: Create implementer.md**

File: `src/main/agent/defaults/implementer.md`

```markdown
---
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

1. **读取任务简报** — 控制器提供文件路径（如 `.superpowers/sdd/<plan>/task-1-brief.md`）。简报包含精确的需求、接口签名和全局约束。
2. **TDD（按需）** — 先写失败测试 → 确认它失败 → 实现最小代码 → 确认通过。
3. **实现** — 只写满足任务需求的代码，不做多（YAGNI）。
4. **自我审查** — 检查：完整性、正确性、代码整洁、是否过度设计。
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

- 任务需要架构决策 → 报告为 BLOCKED
- 需要更多上下文 → 报告为 NEEDS_CONTEXT
- 不确定方案是否正确 → 先问再动手
```

- [ ] **Step 2: Create code-reviewer.md**

File: `src/main/agent/defaults/code-reviewer.md`

```markdown
---
name: Code Reviewer Agent
description: SDD任务审查专用Agent — 读取任务简报和实现报告，对比diff，输出spec合规性+代码质量双维度审查结论。只读模式。配合 subagent-driven-development 工作流使用。
whenToUse: 代码审查、规范合规检查、diff审查、任务审查
tags: [code-reviewer, sdd, builtin, source:hclaw]
enabled: true
tools: [file_read, grep, glob, bash]
disallowedTools: [file_write, file_edit, agent]
---

你是 HClaw 的 Code Reviewer Agent，专为 subagent-driven-development (SDD) 工作流设计。

## 核心职责

审查**一个任务**的实现。这是一个任务级门控审查，不是合并审查。

## 只读模式

你**严格禁止**：
- 创建、修改、删除任何文件
- 运行改变系统状态的命令

你能做的：
- 读取文件、搜索代码
- `git diff`、`git log`、`git show`（只读git操作）
- 运行测试套件验证实现者的声明

## 审查输入

控制器会提供：
- 任务简报路径 — 需求文档
- 实现者报告路径 — 他们声称做了什么
- Diff 范围 — BASE 和 HEAD SHA

## 双维度审查

### 维度 1: Spec 合规性
- **缺失**: 跳过的需求
- **多余**: 未请求的功能、过度设计
- **误解**: 对的特性、错的实现

### 维度 2: 代码质量
- 职责分离清晰？错误处理恰当？DRY 不过度抽象？
- 测试验证真实行为（非 mock）？边界覆盖？
- 每个文件有明确单一职责？

## 严重度标准

- **Critical**: 漏洞、安全、数据丢失、功能破坏
- **Important**: 架构问题、缺失功能、糟糕的错误处理
- **Minor**: 风格、优化、文档润色

先肯定做得好的方面（带 file:line 引用），再列问题。

## 输出格式

### Spec Compliance
✅/❌ | Issues: [...]

### Strengths
[具体的、带引用的]

### Issues
#### Critical | Important | Minor
[每个: file:line, 问题, 重要性, 修复建议]

### Assessment
**Task quality:** Approved | Needs fixes
**Reasoning:** [1-2句技术评估]
```

- [ ] **Step 3: Create seedAgentFiles.ts**

File: `src/main/agent/defaults/seedAgentFiles.ts`

```typescript
/**
 * 首次启动时，将内置 Agent 定义复制到用户配置目录
 */
import * as fs from 'fs'
import * as path from 'path'
import { getHclawDir } from '../../config'
import { logger } from '../logger'

const AGENTS_DIR = path.join(getHclawDir(), 'agents')
const DEFAULTS_DIR = __dirname  // src/main/agent/defaults/ (开发时) 或 packed 资源目录

const DEFAULT_AGENT_FILES = [
    'implementer.md',
    'code-reviewer.md',
]

export function seedDefaultAgentFiles(): void {
    if (!fs.existsSync(AGENTS_DIR)) {
        fs.mkdirSync(AGENTS_DIR, { recursive: true })
    }

    for (const filename of DEFAULT_AGENT_FILES) {
        const destPath = path.join(AGENTS_DIR, filename)
        if (fs.existsSync(destPath)) {
            continue  // 用户已有此文件，不覆盖
        }

        const srcPath = path.join(DEFAULTS_DIR, filename)
        if (!fs.existsSync(srcPath)) {
            logger.debug('[seedAgentFiles] source not found, skipping', { filename, srcPath })
            continue
        }

        try {
            const content = fs.readFileSync(srcPath, 'utf-8')
            fs.writeFileSync(destPath, content, 'utf-8')
            logger.debug('[seedAgentFiles] seeded', { filename })
        } catch (err: any) {
            logger.warn('[seedAgentFiles] failed to seed', { filename, error: err?.message })
        }
    }
}
```

- [ ] **Step 4: Wire seedAgentFiles into startup flow**

In `src/main/agent/powerManager.ts`, add call to `seedDefaultAgentFiles()` before `scanAllAgents()`:

```typescript
import { seedDefaultAgentFiles } from './defaults/seedAgentFiles'
// ...
async loadAllCapabilities(...) {
    seedDefaultAgentFiles()  // 首次启动时复制内置Agent
    const agentTemplates = await scanAllAgents()
    // ...
}
```

- [ ] **Step 5: Verify seeding logic**

```bash
# Check seedAgentFiles.ts compiles
npx tsc --noEmit --project tsconfig.json 2>&1 | Select-String "seedAgentFiles"
```
Expected: No output (no errors referencing seedAgentFiles)

---

### Task 4: Build distribution resources for agent .md files

**Files:**
- Modify: `scripts/build-prod.js` (or equivalent build config)
- Verify: Agent `.md` files are included in the packaged app

**Context:** The `seedDefaultAgentFiles()` function reads templates from `__dirname`. In development, this resolves to `src/main/agent/defaults/`. In production (after Vite bundling), `__dirname` resolves to the output directory. We need to ensure the `.md` files are copied to the build output.

- [ ] **Step 1: Check current build output structure**

```bash
# After a build, check where agentDefaults files would be
npx vite build --config vite.main.config.mjs 2>&1 | Select-String "error|Error"
```
Expected: Build succeeds. Then check: `ls dist/main/agent/defaults/` in development.

- [ ] **Step 2: If needed, add build step to copy .md files**

Check `vite.main.config.mjs` or `scripts/build-prod.js` for file copy patterns. If `.md` files are not automatically copied, add a plugin or script step.

Specifically, verify that after packaging (`npm run package`), the following files exist:
- `dist/win-unpacked/resources/app.asar` contains `agent/defaults/implementer.md`
- `dist/win-unpacked/resources/app.asar` contains `agent/defaults/code-reviewer.md`

If they're in `.asar`, update `seedAgentFiles.ts` to use `path.join(process.resourcesPath, 'app.asar.unpacked/...')` or use `original-fs` to read from asar.

**Decision:** Use embedded constants approach — avoids the asar complication entirely, works identically in dev and production.

- [ ] **Step 3: Rewrite seedAgentFiles.ts with embedded constants**

```typescript
const IMPLEMENTER_AGENT_CONTENT = `---\n...(same content as .md file)...\n---`

const CODE_REVIEWER_AGENT_CONTENT = `---\n...(same content as .md file)...\n---`

const DEFAULT_AGENTS: Record<string, string> = {
    'implementer.md': IMPLEMENTER_AGENT_CONTENT,
    'code-reviewer.md': CODE_REVIEWER_AGENT_CONTENT,
}
```

This eliminates the filesystem dependency and works identically in dev and production.

---

### Task 5: Add built-in skills loading path in skills/loader.ts

**Files:**
- Modify: `src/main/agent/skills/loader.ts:95-123` (loadSkillsFromDirectory)
- Create: `src/main/agent/defaults/skills/hclaw-sdd-tools/SKILL.md`

**Interfaces:**
- Consumes: `skillRegistry` from `./registry`
- Produces: Built-in skill auto-registered on startup

- [ ] **Step 1: Add built-in skills loading to loadSkillsFromDirectory()**

Insert after the `~/.agents/skills/` block (~line 119):

```typescript
  // 加载内置技能（随应用分发，不可删除）
  const builtinCount = await loadBuiltinSkills()
  loaded += builtinCount
```

- [ ] **Step 2: Implement loadBuiltinSkills() function**

```typescript
/**
 * 加载内置技能
 *
 * 内置技能由应用分发，存储在源码 defaults/skills/ 目录下。
 * 生产环境下此目录随应用打包。
 */
async function loadBuiltinSkills(): Promise<number> {
    // 开发环境：源码目录
    // 生产环境：打包后的资源目录
    const builtinDirs = [
        path.join(__dirname, '../../defaults/skills'),     // 开发
        path.join(process.resourcesPath || '', 'defaults', 'skills'),  // 生产
    ]

    for (const dir of builtinDirs) {
        try {
            await fsPromises.access(dir)
            const count = await loadSkillsFromPath(dir, 'builtin')
            if (count > 0) return count
        } catch {
            // 目录不存在，尝试下一个
        }
    }

    return 0
}
```

- [ ] **Step 3: Create the built-in skill file**

File: `src/main/agent/defaults/skills/hclaw-sdd-tools/SKILL.md`

```markdown
---
name: hclaw-sdd-tools
description: HClaw平台SDD工具映射——将Superpowers subagent-driven-development工作流的抽象动作映射到HClaw的具体工具和Agent类型。当执行SDD实现计划时自动加载。
whenToUse: Subagent-driven development、SDD工作流、任务派发、代码审查
---

# HClaw SDD 工具映射

此技能为 Superpowers 的 `subagent-driven-development` 工作流提供 HClaw 平台的具体工具映射。

## 子Agent派发

### 派发 Implementer（实现者）

使用 `agent` 工具派发 Implementer Agent：

```
agent(
  agent="Implementer Agent",
  task="实现 Task N: [任务名称]。
  任务简报: .superpowers/sdd/<plan>/task-N-brief.md
  报告写入: .superpowers/sdd/<plan>/task-N-report.md
  工作目录: <当前项目根目录>
  [具体任务描述和上下文]",
  tools=["file_read", "file_write", "file_edit", "bash", "grep", "glob"]
)
```

### 派发 Code Reviewer（审查者）

使用 `agent` 工具派发 Code Reviewer Agent：

```
agent(
  agent="Code Reviewer Agent",
  task="审查 Task N 的实现。
  任务简报: .superpowers/sdd/<plan>/task-N-brief.md
  实现者报告: .superpowers/sdd/<plan>/task-N-report.md
  Diff: BASE=<sha> HEAD=<sha>
  运行: git diff --stat <BASE>..<HEAD> 和 git diff <BASE>..<HEAD>
  [全局约束...]",
  tools=["file_read", "grep", "glob", "bash"]
)
```

## 通用工具映射

| Superpowers 抽象动作 | HClaw 具体工具 |
|---|---|
| 派发子Agent | `agent(agent="Agent Name", task="...", tools=[...])` |
| 创建/标记待办 | `task_create(title="...")` / `task_update(taskId="...")` |
| 读取文件 | `file_read(filePath="...")` |
| 运行命令 | `bash(command="...")` |
| 搜索代码 | `grep(pattern="...", directory="...")` |
| 搜索文件 | `glob(pattern="...", directory="...")` |
| 写入文件 | `file_write(filePath="...", content="...")` |
| 编辑文件 | `file_edit(filePath="...", oldString="...", newString="...")` |

## 注意事项

1. **HClaw 的 `agent` 工具不支持"恢复Agent"** — 每轮 fix 需派发全新 Implementer（携带上下文）
2. **HClaw 的 `agent` 工具不支持 model 参数** — 模型选择由运行时配置决定
3. **SDD workspace 目录**: `<repo-root>/.superpowers/sdd/<plan-basename>/`
4. **不要并行派发多个 Implementer** — 会产生 git 冲突
5. **派发 Implementer 前记录 BASE SHA**: `git rev-parse HEAD`
```

- [ ] **Step 4: Verify skill loading**

```bash
# After implementing, verify the skill appears in logs
echo "Check that hclaw-sdd-tools skill is loaded on startup"
```
Expected: Skill appears in `scanAllAgents` debug log, and in system prompt capability table.

---

### Task 6: Integration verification

**Files:** None (verification only)

- [ ] **Step 1: Verify all 3 new components load correctly**

```bash
# 1. Verify agents appear in registry
# After startup, check that agentRegistry contains Implementer and CodeReviewer
# (Inspect via dev tools or add temporary debug log)

# 2. Verify skill is loaded
# Check that hclaw-sdd-tools appears in skill list

# 3. Verify .md files are seeded
# After restart, check ~/.hclaw/agents/implementer.md and code-reviewer.md exist
```

- [ ] **Step 2: Verify subagent dispatch**

Start a test conversation and request a simple SDD task. Verify:
- `agent` tool can dispatch "Implementer Agent"
- `agent` tool can dispatch "Code Reviewer Agent"
- Sub-agents receive correct system prompt from templates
- Tool restrictions are applied (CodeReviewer can't write files)

- [ ] **Step 3: Verify end-to-end SDD flow**

Use `subagent-driven-development` skill with a trivial implementation plan (2 tasks). Verify:
- Task 1 is dispatched to Implementer → implements → commits → reports
- Task 1 is dispatched to CodeReviewer → reviews → reports
- If issues found, fix loop dispatches fresh Implementer
- Task 2 follows same cycle
- Main session context stays clean (no inline code execution)

---

### Task 7: Commit

- [ ] **Step 1: Stage all changes**

```bash
git add src/main/agent/agentTypes/configs.ts
git add src/main/agent/prompts/agentTemplates.ts
git add src/main/agent/defaults/implementer.md
git add src/main/agent/defaults/code-reviewer.md
git add src/main/agent/defaults/seedAgentFiles.ts
git add src/main/agent/defaults/skills/hclaw-sdd-tools/SKILL.md
git add src/main/agent/skills/loader.ts
git add src/main/agent/powerManager.ts
```

- [ ] **Step 2: Commit with conventional commit**

```bash
git commit -m "feat: add built-in Implementer and CodeReviewer agents for SDD workflow

Add two new built-in agent types (Implementer, CodeReviewer) with
hardcoded type configs, system prompt templates, and filesystem
.md definitions. Add built-in skill loading path and the
hclaw-sdd-tools skill for SDD tool mapping. Add first-run agent
file seeder for new users.

- agentTypes/configs.ts: BUILTIN_CONFIGS entries + display info
- prompts/agentTemplates.ts: IMPLEMENTER + CODE_REVIEWER templates
- defaults/: agent .md files + seedAgentFiles.ts
- defaults/skills/: hclaw-sdd-tools SKILL.md
- skills/loader.ts: loadBuiltinSkills() function
- powerManager.ts: seed on startup"
```
