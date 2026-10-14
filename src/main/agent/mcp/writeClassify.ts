/**
 * MCP 工具读/写判定纯函数
 *
 * ── 约束（改动前必读）────────────────────────────────────
 * 1. 纯函数：本文件不得产生副作用，不得读取任何全局/外部状态。
 * 2. 禁引 electron：本目录模块运行在 Agent Worker 线程，引入 electron 会直接崩溃。
 * 3. 判定顺序不可调换：配置覆写 > annotations 标注 > 名字启发式 > unknown。
 *    任意两步互换都会改变判定结果（例如 writeTools 必须压过 readOnlyHint）。
 * 4. annotations 结构单点定义在 ./types 的 MCPToolAnnotations，本文件不得重复声明。
 *
 * 消费方：Task 5 / Task 6 的只读守卫共用 classifyMcpToolWrite 做语义判定，
 * 由 evaluateReadOnlyMcpAccess 在边界层消费 unknownPolicy 并产出文案。
 *
 * ── 判别力验证（变异实验，2026-10-14，已还原）────────────────
 * 变异：tokenizeToolName 临时改为 `name.toLowerCase().split('_').filter(Boolean)`（去掉 camelCase 切分）。
 *   变异后：Test Files 1 failed (1) | Tests 2 failed | 19 passed (21)
 *     红 1：`triggerBuild → write（camelCase 切分命中 trigger/build）`
 *           AssertionError: expected 'unknown' to be 'write' // Object.is equality
 *     红 2：`tokenizeToolName > 按 _ / - / . 与 camelCase 边界切词并小写化`
 *           AssertionError: expected [ 'triggerbuild' ] to deeply equal [ 'trigger', 'build' ]
 *   还原后：Test Files 1 passed (1) | Tests 21 passed (21)
 * 结论：camelCase 切分分支被上述两用例覆盖，去掉即红，判别力成立。
 *   注：brief Step 5 只预期 triggerBuild 一条变红，实测多出 tokenizeToolName 一条
 *   （该用例同时覆盖分隔符归一 + camelCase 切分，变异会一并破坏），已如实记录。
 */

import type {MCPToolAnnotations} from './types'

/** 判定结论：读 / 写 / 无法判定 */
export type McpWriteVerdict = 'read' | 'write' | 'unknown'

/** 用户在 MCP 配置中的覆写（与 denyList/autoApprove 同口径：MCP 侧原始工具名） */
export interface McpWriteOverride {
    /** 与 denyList/autoApprove 同口径：MCP 侧原始工具名 */
    readOnlyTools?: string[]
    writeTools?: string[]
    unknownPolicy?: 'allow' | 'deny'
}

export interface ClassifyMcpToolWriteInput {
    /** MCP 侧原始工具名（非 proxy 名） */
    rawToolName: string
    annotations?: MCPToolAnnotations
    override?: McpWriteOverride
}

export const READ_NAME_WORDS: readonly string[] = [
    'read', 'get', 'list', 'search', 'query', 'find', 'explore', 'view', 'show',
    'describe', 'inspect', 'fetch', 'lookup', 'count', 'status', 'whoami', 'history',
    'diff', 'log', 'tree', 'stat', 'grep', 'glob',
]

export const WRITE_NAME_WORDS: readonly string[] = [
    'write', 'create', 'update', 'delete', 'edit', 'remove', 'move', 'mkdir', 'rmdir',
    'put', 'push', 'upload', 'apply', 'merge', 'insert', 'patch', 'rename', 'truncate',
    'drop', 'grant', 'chmod', 'add', 'post', 'send', 'clone', 'fork', 'register',
    'publish', 'import', 'append', 'upsert', 'enable', 'disable', 'execute', 'run',
    'install', 'deploy', 'trigger', 'build', 'commit', 'set',
]

/**
 * 按 camelCase 边界与 `_` / `-` / `.` 等分隔符切词并小写化。
 *
 * 例：'codegraph_explore' → ['codegraph', 'explore']
 *     'triggerBuild'      → ['trigger', 'build']
 *     'get-HTTP.Status'   → ['get', 'http', 'status']
 */
export function tokenizeToolName(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')  // camelCase → snake_case
        .replace(/[^a-zA-Z0-9]+/g, '_')          // 其余分隔符归一为 _
        .toLowerCase()
        .split('_')
        .filter(Boolean)
}

/**
 * 判定 MCP 工具是读还是写。
 *
 * 判定顺序（固定，不可调换）：
 * 1. override.writeTools 命中 → 'write'（压过 annotations 的只读声明）
 * 2. override.readOnlyTools 命中 → 'read'
 * 3. annotations 存在 → readOnlyHint === true ? 'read' : 'write'
 * 4. 名字启发式：写词命中 → 'write'；读词命中 → 'read'（读写同命中取 write）
 * 5. → 'unknown'
 */
export function classifyMcpToolWrite(input: ClassifyMcpToolWriteInput): McpWriteVerdict {
    const {rawToolName, annotations, override} = input

    if (override?.writeTools?.includes(rawToolName)) return 'write'
    if (override?.readOnlyTools?.includes(rawToolName)) return 'read'

    if (annotations !== undefined) {
        return annotations.readOnlyHint === true ? 'read' : 'write'
    }

    const tokens = tokenizeToolName(rawToolName)
    if (tokens.some(t => WRITE_NAME_WORDS.includes(t))) return 'write'
    if (tokens.some(t => READ_NAME_WORDS.includes(t))) return 'read'

    return 'unknown'
}

/** 只读守卫决策结果；allowed=true 时无 error */
export interface ReadOnlyGuardResult {
    allowed: boolean
    error?: string
}

/**
 * 边界层：消费 unknownPolicy 并产出二因分列文案。
 *
 * - read → 放行
 * - write → 拒绝（写操作因）
 * - unknown → unknownPolicy === 'allow' 放行，否则拒绝（无法判定因）
 */
export function evaluateReadOnlyMcpAccess(input: ClassifyMcpToolWriteInput): ReadOnlyGuardResult {
    const verdict = classifyMcpToolWrite(input)
    if (verdict === 'read') return {allowed: true}
    if (verdict === 'write') {
        return {
            allowed: false,
            error: `只读模式：MCP 工具「${input.rawToolName}」被判定为写操作，已阻止调用。`,
        }
    }
    if (input.override?.unknownPolicy === 'allow') return {allowed: true}
    return {
        allowed: false,
        error: `只读模式：无法判定 MCP 工具「${input.rawToolName}」为只读，已按保守策略阻止。可在 MCP 配置中将其列入 readOnlyTools 后重试。`,
    }
}
