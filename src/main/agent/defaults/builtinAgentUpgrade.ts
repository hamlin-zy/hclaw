/**
 * 内置 Agent 模板升级机制（判定链第 1、2 层）
 *
 * 背景：`seedDefaultAgentFiles` 原本只写 `missing`/`corrupt` 文件，`valid` 一律不覆盖，
 * 导致内置模板随版本演进的修复永远到不了老用户机器上。
 *
 * 判定链：
 *   1. **manifest 指纹基线** — 记录"我们整体写入过"的内容 sha1。磁盘内容 hash 与之相等
 *      → 认定用户未改动 → 允许整体替换为新模板（可带上文案重写等大改）。
 *   2. **锚点式补丁迁移** — 用户改过、或来源不明（无 manifest 条目）时，只做
 *      "精确旧文本 → 新文本"的定向替换；锚点不命中即跳过，绝不覆盖用户改动。
 *   3. 历史 hash 兜底（未实现）— 内嵌历代模板 sha1，让老用户也能走第 1 层。
 *
 * ── 安全不变量（改动本文件务必保持）────────────────────────
 *   a. `pristineHash` 只在我们**整体写入文件的那一刻**记录，绝不在扫描/加载时
 *      用磁盘内容回填 —— 否则用户改动会被误标为"未改动"，下次整体替换将覆盖它。
 *   b. 所有写操作都以"指纹命中"或"锚点命中"为前提；判定不确定一律不动（fail-closed）。
 *   c. 迁移按**字段语义**而非裸字符串执行：只改 `fieldMapper` 优先级下真正生效的那个
 *      别名键（`allowedTools` > `allowed_tools` > `tools`），否则会出现"锚点命中但
 *      生效值来自更高优先级同义键"的空转（本仓库 plan.md 真实踩过此坑）。
 *   d. 迁移后执行生效校验（`verifyToolEffectiveness`），不通过则回滚该文件。
 *
 * 失败方向始终是"漏升级"而非"误覆盖"：任何不确定的分支都退回不做。
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import yaml from 'js-yaml'
import {getAgentField} from '../../utils/fieldMapper'

/** manifest 文件名。刻意不带扩展名：Agent 目录扫描（walkDir）只收 .md/.json/.yaml/.yml，避免被抓成 Agent。 */
export const MANIFEST_FILENAME = '.builtin-manifest'
const MANIFEST_VERSION = 1

export interface BuiltinAgentManifestEntry {
    /** 我们整体写入过的内容的 sha1；锚点迁移过的文件不写入此字段（见安全不变量 a） */
    pristineHash?: string
    /**
     * 已送达该文件的补丁迁移 id。**仅用于诊断/后续 UI**，不参与升级判定 ——
     * 迁移本身是幂等的（已满足即 noop），按记录跳过反而会引入"记录说已应用、
     * 但用户又改回去"的漏判风险。
     */
    appliedMigrations?: string[]
    updatedAt?: number
}

interface BuiltinAgentManifest {
    version: number
    files: Record<string, BuiltinAgentManifestEntry>
}

interface MigrationResult {
    outcome: 'applied' | 'noop' | 'skipped'
    content: string
    /** 同语义的低优先级别名键（不生效）——仅用于日志诊断 */
    shadowedKeys?: string[]
    reason?: string
}

interface BuiltinTemplateMigration {
    id: string
    /** 目标内置模板文件名，如 'plan.md' */
    file: string
    description: string
    apply(content: string): MigrationResult
}

/** 待校验的工具生效性断言 */
interface ToolEffectivenessCheck {
    /** 必须处于"可用"状态（未被白名单排除、未被黑名单禁止） */
    required: string[]
    /** 必须处于"不可用"状态 */
    forbidden: string[]
}

// ─── 基础工具 ────────────────────────────────────────────

export function contentHash(content: string): string {
    return crypto.createHash('sha1').update(content, 'utf-8').digest('hex')
}

function emptyManifest(): BuiltinAgentManifest {
    return {version: MANIFEST_VERSION, files: {}}
}

export function loadManifest(manifestPath: string): BuiltinAgentManifest {
    try {
        if (!fs.existsSync(manifestPath)) return emptyManifest()
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        if (!raw || typeof raw !== 'object' || typeof raw.files !== 'object' || raw.files === null) {
            return emptyManifest()
        }
        return {version: MANIFEST_VERSION, files: raw.files as Record<string, BuiltinAgentManifestEntry>}
    } catch {
        // manifest 损坏 → 视为"无基线"（保守路径：只做锚点迁移），不阻断启动
        return emptyManifest()
    }
}

export function saveManifest(manifestPath: string, manifest: BuiltinAgentManifest): void {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
}

// ─── frontmatter 字段语义（镜像 fieldMapper 优先级）────────

const TOOLS_KEY_PRIORITY = ['allowedTools', 'allowed_tools', 'tools'] as const
const DISALLOWED_KEY_PRIORITY = ['disallowedTools', 'disallowed_tools', 'restricted_tools'] as const

interface SplitContent {
    /** frontmatter 文本（不含首尾 --- 行） */
    frontmatterText: string
    /** 闭合 --- 之后的全部内容（含换行） */
    rest: string
    /** 分隔符行与 frontmatter 使用的换行符 */
    eol: string
}

/** 拆分内置模板的 frontmatter。无 frontmatter 时返回 null。 */
export function splitBuiltinFrontmatter(content: string): SplitContent | null {
    const match = /^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content)
    if (!match) return null
    return {frontmatterText: match[2], rest: content.slice(match[0].length), eol: match[1]}
}

interface KeyLine {
    key: string
    lineIndex: number
    /** ':' 之后的原始值文本 */
    valueText: string
}

function findEffectiveKeyLine(frontmatterText: string, keyPriority: readonly string[]): KeyLine | undefined {
    const lines = frontmatterText.split(/\r?\n/)
    for (const key of keyPriority) {
        const re = new RegExp(`^[ \\t]*${key}[ \\t]*:(.*)$`)
        for (let i = 0; i < lines.length; i++) {
            const m = re.exec(lines[i])
            if (m) return {key, lineIndex: i, valueText: m[1].trim()}
        }
    }
    return undefined
}

function findShadowedKeys(frontmatterText: string, keyPriority: readonly string[], effectiveKey: string): string[] {
    const lines = frontmatterText.split(/\r?\n/)
    return keyPriority
        .filter((k) => k !== effectiveKey && lines.some((l) => new RegExp(`^[ \\t]*${k}[ \\t]*:`).test(l)))
}

/** 解析行内 YAML 数组值。块序列/非法值返回 null（→ 迁移走 fail-closed 的 skipped）。 */
function parseInlineToolList(valueText: string): string[] | null {
    if (!valueText.startsWith('[')) return null
    try {
        const parsed = yaml.load(valueText)
        if (!Array.isArray(parsed)) return null
        return parsed.filter((v): v is string => typeof v === 'string')
    } catch {
        return null
    }
}

function formatInlineToolList(list: string[], quoted: boolean): string {
    const items = list.map((t) => (quoted ? `"${t}"` : t))
    return `[${items.join(', ')}]`
}

/**
 * 对生效键所声明的工具列表做定向增删。
 * `mutate` 返回 null 表示"无需改动"（幂等 noop）。
 */
function mutateEffectiveToolList(
    content: string,
    keyPriority: readonly string[],
    mutate: (list: string[]) => string[] | null,
): MigrationResult {
    const split = splitBuiltinFrontmatter(content)
    if (!split) return {outcome: 'skipped', content, reason: 'no-frontmatter'}

    const keyLine = findEffectiveKeyLine(split.frontmatterText, keyPriority)
    if (!keyLine) return {outcome: 'noop', content, reason: 'no-tools-key'}

    const list = parseInlineToolList(keyLine.valueText)
    if (!list) return {outcome: 'skipped', content, reason: `unparsable-${keyLine.key}`}

    const next = mutate(list)
    if (!next) return {outcome: 'noop', content, reason: 'already-satisfied'}

    const quoted = keyLine.valueText.includes('"')
    const lines = split.frontmatterText.split(/\r?\n/)
    lines[keyLine.lineIndex] = `${keyLine.key}: ${formatInlineToolList(next, quoted)}`

    const shadowedKeys = findShadowedKeys(split.frontmatterText, keyPriority, keyLine.key)
    return {
        outcome: 'applied',
        content: `---${split.eol}${lines.join(split.eol)}${split.eol}---${split.eol}${split.rest}`,
        shadowedKeys,
    }
}

/**
 * 正文块替换：换行符自适应（先 LF 再 CRLF），未命中返回 skipped。
 */
function replaceTextBlock(content: string, oldBlock: string, newBlock: string, reason: string): MigrationResult {
    for (const eol of ['\n', '\r\n']) {
        const oldText = oldBlock.replace(/\n/g, eol)
        const idx = content.indexOf(oldText)
        if (idx !== -1) {
            const newText = newBlock.replace(/\n/g, eol)
            return {outcome: 'applied', content: content.slice(0, idx) + newText + content.slice(idx + oldText.length)}
        }
    }
    return {outcome: 'skipped', content, reason}
}

// ─── 工具列表增删的纯函数 ─────────────────────────────────

function addToList(list: string[], tool: string): string[] | null {
    return list.includes(tool) ? null : [...list, tool]
}

function removeFromList(list: string[], tools: string[]): string[] | null {
    const next = list.filter((t) => !tools.includes(t))
    return next.length === list.length ? null : next
}

// ─── 冒烟的迁移锚点文本（旧内置模板原样）─────────────────

const PLAN_OLD_READONLY_BLOCK = `=== 只读模式 ===
你**严格禁止**：
- 创建、修改、删除任何文件
- 运行改变系统状态的命令
- 派发子 Agent

你的职责**仅限**探索代码库并设计实施计划。`

const PLAN_NEW_PLANNING_BLOCK = `=== 规划模式 ===
你的职责是探索代码库、设计方案，并把最终计划**落盘**为规划文档。
你可以并应当使用 file_write 将计划写入规划文档（如 docs/plans/<name>.md）。

你**严格禁止**：
- 修改/编辑任何源码或既有文件（无 file_edit，禁止覆盖源码）
- 运行改变系统状态的命令（无 bash）
- 派发子 Agent`

const PLAN_OLD_TRAILING_LINE = '记住：你只能探索和规划。**绝不能**写、编辑或修改任何文件。'

const PLAN_NEW_TRAILING_BLOCK = `## 落盘要求

完成规划后，**必须**使用 file_write 将计划写入规划文档（默认 \`docs/plans/<slug>.md\`），
并在回复中给出该文件路径。不得修改或覆盖任何源码与既有文件。

记住：你只负责探索、规划，并把计划写入规划文档；**绝不能**修改或覆盖任何源码与既有文件。`

// ─── 迁移注册表 ──────────────────────────────────────────

export const BUILTIN_TEMPLATE_MIGRATIONS: BuiltinTemplateMigration[] = [
    {
        id: 'plan-allow-file-write',
        file: 'plan.md',
        description: 'Plan 白名单补入 file_write（按 fieldMapper 优先级写入真正生效的别名键）',
        apply: (content) => mutateEffectiveToolList(content, TOOLS_KEY_PRIORITY, (list) => addToList(list, 'file_write')),
    },
    {
        id: 'plan-unblock-file-write',
        file: 'plan.md',
        description: 'Plan 黑名单移除 file_write（并清理不存在的 notebook_edit / browser_tool 残留）',
        apply: (content) =>
            mutateEffectiveToolList(content, DISALLOWED_KEY_PRIORITY, (list) =>
                removeFromList(list, ['file_write', 'notebook_edit', 'browser_tool']),
            ),
    },
    {
        id: 'explore-drop-dead-tool-names',
        file: 'explore.md',
        description: 'Explore 黑名单清理不存在的 notebook_edit 残留',
        apply: (content) =>
            mutateEffectiveToolList(content, DISALLOWED_KEY_PRIORITY, (list) => removeFromList(list, ['notebook_edit'])),
    },
    {
        id: 'plan-prompt-planning-mode',
        file: 'plan.md',
        description: 'Plan 正文由"只读模式"改为"规划模式"，允许落盘计划文档',
        apply: (content) => replaceTextBlock(content, PLAN_OLD_READONLY_BLOCK, PLAN_NEW_PLANNING_BLOCK, 'anchor-miss-readonly-block'),
    },
    {
        id: 'plan-prompt-plan-file-output',
        file: 'plan.md',
        description: 'Plan 正文补充"落盘要求"章节并修正收尾语',
        apply: (content) => replaceTextBlock(content, PLAN_OLD_TRAILING_LINE, PLAN_NEW_TRAILING_BLOCK, 'anchor-miss-trailing-line'),
    },
]

/** 每个内置模板的生效性断言（迁移后校验，不通过则回滚） */
const BUILTIN_TEMPLATE_CHECKS: Record<string, ToolEffectivenessCheck> = {
    'plan.md': {required: ['file_write'], forbidden: []},
}

// ─── 生效校验 ────────────────────────────────────────────

function parseToolsValue(value: unknown): string[] | undefined {
    if (value === undefined) return undefined
    if (value === '*') return undefined
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
    return undefined
}

/**
 * 校验工具在白/黑名单语义下是否真的可用。
 * 镜像 `filterToolsForAgent` 的判定顺序（黑名单先于白名单，白名单缺省 = 不限制）。
 */
export function verifyToolEffectiveness(
    content: string,
    check: ToolEffectivenessCheck,
): {ok: boolean; reason?: string} {
    const split = splitBuiltinFrontmatter(content)
    if (!split) return {ok: false, reason: 'no-frontmatter'}

    let frontmatter: Record<string, unknown>
    try {
        frontmatter = (yaml.load(split.frontmatterText) as Record<string, unknown>) ?? {}
    } catch {
        return {ok: false, reason: 'frontmatter-parse-failed'}
    }

    // getAgentField 承载别名与优先级（与 Agent 加载口径一致）
    const tools = parseToolsValue(getAgentField(frontmatter, 'allowedTools'))
    const disallowed = parseToolsValue(getAgentField(frontmatter, 'disallowedTools')) ?? []
    const wildcard = tools === undefined

    const isAvailable = (tool: string): boolean => {
        if (disallowed.includes(tool)) return false
        if (wildcard) return true
        return tools!.includes(tool)
    }

    for (const tool of check.required) {
        if (!isAvailable(tool)) return {ok: false, reason: `required-unavailable:${tool}`}
    }
    for (const tool of check.forbidden) {
        if (isAvailable(tool)) return {ok: false, reason: `forbidden-available:${tool}`}
    }
    return {ok: true}
}

// ─── 迁移执行 ────────────────────────────────────────────

interface MigrationRunReport {
    content: string
    applied: string[]
    skipped: string[]
    changed: boolean
    /** 执行过程中发现的别名键遮蔽（诊断用） */
    shadowed: Array<{id: string; keys: string[]}>
}

/** 对单个文件依次执行所有适用迁移（幂等：已满足的迁移返回 noop，不产生写盘） */
export function runMigrations(filename: string, content: string): MigrationRunReport {
    const applied: string[] = []
    const skipped: string[] = []
    const shadowed: Array<{id: string; keys: string[]}> = []
    let current = content

    for (const migration of BUILTIN_TEMPLATE_MIGRATIONS) {
        if (migration.file !== filename) continue
        const result = migration.apply(current)
        if (result.shadowedKeys?.length) shadowed.push({id: migration.id, keys: result.shadowedKeys})
        if (result.outcome === 'applied') {
            current = result.content
            applied.push(migration.id)
        } else if (result.outcome === 'skipped') {
            skipped.push(`${migration.id}(${result.reason ?? 'unknown'})`)
        }
    }

    return {content: current, applied, skipped, shadowed, changed: current !== content}
}

/**
 * 升级单个内置模板文件的完整决策。
 *
 * @param current 磁盘上的现有内容
 * @param template 当前版本的内置模板内容
 * @param entry manifest 中该文件的既有条目（可空 = 来源不明）
 */
interface UpgradeDecision {
    action: 'replace' | 'migrate' | 'unchanged' | 'none'
    content: string
    /** 是否应写入 manifest 的 pristineHash（指纹命中，即 action 为 replace/unchanged 时为 true） */
    recordPristine: boolean
    appliedMigrations: string[]
    skippedMigrations: string[]
    shadowed: Array<{id: string; keys: string[]}>
    /** 生效校验失败时的原因（此时 action 已回退为 'none'） */
    verifyFailure?: string
}

export function decideBuiltinTemplateUpgrade(
    filename: string,
    current: string,
    template: string,
    entry: BuiltinAgentManifestEntry | undefined,
): UpgradeDecision {
    const base = {appliedMigrations: [] as string[], skippedMigrations: [] as string[], shadowed: [] as Array<{id: string; keys: string[]}>}

    // 第 1 层：指纹命中 = 用户未改动 → 允许整体替换
    if (entry?.pristineHash && contentHash(current) === entry.pristineHash) {
        if (current === template) return {action: 'unchanged', content: current, recordPristine: true, ...base}
        const check = BUILTIN_TEMPLATE_CHECKS[filename]
        if (check) {
            const verdict = verifyToolEffectiveness(template, check)
            if (!verdict.ok) {
                return {action: 'none', content: current, recordPristine: false, ...base, verifyFailure: verdict.reason}
            }
        }
        return {action: 'replace', content: template, recordPristine: true, ...base}
    }

    // 第 2 层：用户改过 / 来源不明 → 只做锚点式补丁迁移
    const report = runMigrations(filename, current)
    const check = BUILTIN_TEMPLATE_CHECKS[filename]
    if (check) {
        const verdict = verifyToolEffectiveness(report.content, check)
        if (!verdict.ok) {
            // 回滚：绝不留下"改了一半且未生效"的文件
            return {
                action: 'none',
                content: current,
                recordPristine: false,
                appliedMigrations: [],
                skippedMigrations: report.skipped,
                shadowed: report.shadowed,
                verifyFailure: verdict.reason,
            }
        }
    }

    return {
        action: report.changed ? 'migrate' : 'unchanged',
        content: report.content,
        recordPristine: false,
        appliedMigrations: report.applied,
        skippedMigrations: report.skipped,
        shadowed: report.shadowed,
    }
}
