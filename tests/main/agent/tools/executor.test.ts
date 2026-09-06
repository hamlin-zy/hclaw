/**
 * executor 结果大小检查单元测试
 *
 * 覆盖本次修复（bash 工具输出截断）：
 * - bash 工具使用差异化阈值（2MB），不再被 15KB 通用阈值截断
 * - 其他工具维持通用阈值（15KB），超过仍截断
 * - 阈值内输出原样返回（不添加截断标记）
 * - 超过通用阈值但低于警告阈值时不截断
 */
import {describe, expect, it} from 'vitest'
import {checkResultSize, resolveToolTimeoutMs} from '../../../../src/main/agent/tools/executor'

function okResult(output: string) {
    return {success: true, output}
}

describe('checkResultSize', () => {
    it('bash 工具输出超过 15KB 但不截断（差异化阈值 2MB）', () => {
        // 20KB > 通用 15KB 阈值，但 bash 应使用 2MB 阈值
        const big = 'x'.repeat(20 * 1024)
        const result = checkResultSize('bash', okResult(big))
        expect(result.output).toContain(big) // 完整内容保留
        expect(result.output).not.toContain('[结果已截断]')
    })

    it('bash 工具输出超过 2MB 时仍截断（内部上限兜底一致）', () => {
        // 2MB + 100 字符 > 2MB 阈值 → 应截断
        const huge = 'x'.repeat(2 * 1024 * 1024 + 100)
        const result = checkResultSize('bash', okResult(huge))
        expect(result.output).toContain('[结果已截断]')
        expect(result.output.length).toBeLessThan(huge.length)
    })

    it('非 bash 工具超过 15KB 仍按通用阈值截断', () => {
        const big = 'y'.repeat(20 * 1024)
        const result = checkResultSize('grep', okResult(big))
        expect(result.output).toContain('[结果已截断]')
        expect(result.output).toContain('超过 15000 字符限制')
    })

    it('agent 工具输出超过 15KB 不截断（子 Agent 工作报告完整性豁免）', () => {
        // 30KB > 通用 15KB 阈值，但 agent 是子 Agent 工作报告，应完整保留
        const big = 'a'.repeat(30 * 1024)
        const result = checkResultSize('agent', okResult(big))
        expect(result.output).toContain(big) // 完整内容保留
        expect(result.output).not.toContain('[结果已截断]')
    })

    it('agent 工具输出超过警告阈值时不追加警告（Infinity 完全豁免）', () => {
        // 10KB > 5KB 警告阈值，但 agent 阈值 Infinity 表示完全豁免（连警告尾巴也不加）
        const big = 'a'.repeat(10 * 1024)
        const result = checkResultSize('agent', okResult(big))
        expect(result.output).toBe(big)
        expect(result.output).not.toContain('[警告] 结果较大')
    })

    it('skill 工具输出超过警告阈值时不追加警告（buildGuidance 三端一致性豁免）', () => {
        // 10KB > 5KB 警告阈值，但 skill output 是 buildGuidance 原文，警告尾巴会破坏一致性
        const big = 'g'.repeat(10 * 1024)
        const result = checkResultSize('skill', okResult(big))
        expect(result.output).toBe(big) // 完整内容保留，无尾巴
        expect(result.output).not.toContain('[警告] 结果较大')
        expect(result.output).not.toContain('[结果已截断]')
    })

    it('输出为空时不处理', () => {
        const result = checkResultSize('bash', {success: true, output: ''})
        expect(result.output).toBe('')
    })

    it('输出在警告阈值内时原样返回', () => {
        const small = 'z'.repeat(1000)
        const result = checkResultSize('file_read', okResult(small))
        expect(result.output).toBe(small)
    })

    it('输出在警告与截断阈值之间时添加警告但不截断', () => {
        // 10KB > 5KB 警告阈值，但 < 15KB 截断阈值
        const mid = 'w'.repeat(10 * 1024)
        const result = checkResultSize('file_read', okResult(mid))
        expect(result.output).toContain('[警告] 结果较大')
        expect(result.output).not.toContain('[结果已截断]')
        expect(result.output).toContain(mid) // 完整内容保留
    })
})

describe('resolveToolTimeoutMs（工具执行超时解析，倒计时数据源）', () => {
    it('bash：无参数时返回内部默认 30s', () => {
        expect(resolveToolTimeoutMs('bash')).toBe(30000)
    })

    it('bash：LLM 传入秒数（<1000）自动视为秒转毫秒', () => {
        expect(resolveToolTimeoutMs('bash', {timeout: 30})).toBe(30000)
    })

    it('bash：传入毫秒（>=1000）原样使用', () => {
        expect(resolveToolTimeoutMs('bash', {timeout: 5000})).toBe(5000)
    })

    it('web_fetch：无参数时返回内部默认 15s', () => {
        expect(resolveToolTimeoutMs('web_fetch')).toBe(15000)
    })

    it('web_fetch：参数覆盖生效', () => {
        expect(resolveToolTimeoutMs('web_fetch', {timeout: 30000})).toBe(30000)
    })

    it('agent / ask_user：不显示倒计时（返回 undefined）', () => {
        expect(resolveToolTimeoutMs('agent')).toBeUndefined()
        expect(resolveToolTimeoutMs('ask_user')).toBeUndefined()
    })

    it('未知工具：返回通用默认 60s（不依赖 DB，纯默认分支）', () => {
        // 注意：此分支内部会先查 DB，但测试环境无 DB 时 toolRepo.getTimeout 返回 null
        // 因此结果应回退到 getToolDefaultTimeout → 60000
        const result = resolveToolTimeoutMs('some_unknown_tool_xyz')
        expect(result).toBe(60000)
    })
})

// ── Agent 白名单运行时校验 ──────────────────────────────
import {executeTool} from '../../../../src/main/agent/tools/executor'
import {toolRegistry} from '../../../../src/main/agent/tools/registry'
import {makeTool} from './testHelpers'

const baseContext = {
    workingDir: '',
    abortSignal: new AbortController().signal,
    sendMessage: () => {},
} as any

describe('executeTool 白名单校验（allowedToolNames）', () => {
    const probe = 'whitelist_probe_tool'
    toolRegistry.register(makeTool(probe))
    const call = {id: 'tc-1', name: probe, arguments: {}}

    it('白名单外的已注册工具被拒绝（幻觉调用拦截）', async () => {
        const result = await executeTool(call, {...baseContext, allowedToolNames: new Set(['other_tool'])})
        expect(result.denied).toBe(true)
        expect(result.result.success).toBe(false)
        expect(result.result.error).toContain('不在当前 Agent 的可用工具列表中')
    })

    it('白名单内的工具正常执行', async () => {
        const result = await executeTool(call, {...baseContext, allowedToolNames: new Set([probe])})
        expect(result.result.success).toBe(true)
        expect(result.denied).toBeUndefined()
    })

    it('未传 allowedToolNames 时不限制（主 Agent 路径向后兼容）', async () => {
        const result = await executeTool(call, baseContext)
        expect(result.result.success).toBe(true)
    })
})

// ── Agent 黑名单运行时校验 ──────────────────────────────
// 修复 3：新增 disallowedToolNames 运行时校验。
// 纵深防御：即使白名单被 args.tools=['*'] 覆盖而放宽，
// 黑名单仍能拦截被 disallowedTools 禁止的工具。
describe('executeTool 黑名单校验（disallowedToolNames）', () => {
    const probe = 'blacklist_probe_tool'
    const probe2 = 'blacklist_probe_tool2'
    toolRegistry.register(makeTool(probe))
    toolRegistry.register(makeTool(probe2))
    const call = {id: 'tc-b1', name: probe, arguments: {}}
    const call2 = {id: 'tc-b2', name: probe2, arguments: {}}

    it('黑名单内的工具被拒绝', async () => {
        const result = await executeTool(call, {
            ...baseContext,
            disallowedToolNames: new Set([probe]),
        })
        expect(result.denied).toBe(true)
        expect(result.result.success).toBe(false)
        expect(result.result.error).toContain('disallowedTools 列表禁止')
    })

    it('黑名单外的工具正常执行', async () => {
        const result = await executeTool(call, {
            ...baseContext,
            disallowedToolNames: new Set([probe2]),
        })
        expect(result.result.success).toBe(true)
        expect(result.denied).toBeUndefined()
    })

    it('未传 disallowedToolNames 时不限制（向后兼容）', async () => {
        const result = await executeTool(call, baseContext)
        expect(result.result.success).toBe(true)
    })

    /**
     * 核心场景：白名单为 ['*']（全部允许）+ 黑名单禁 probe2。
     * 白名单不限制（undefined 或全量），黑名单仍能拦截。
     * 模拟 args.tools=['*'] 覆盖了 agent 白名单的情况。
     */
    it('白名单不限制 + 黑名单禁止 → 工具被拒绝（纵深防御）', async () => {
        const result = await executeTool(call2, {
            ...baseContext,
            // allowedToolNames 未传 = 不限制（模拟 tools=['*'] 场景）
            disallowedToolNames: new Set([probe2]),
        })
        expect(result.denied).toBe(true)
        expect(result.result.success).toBe(false)
    })

    /**
     * 白名单允许 + 黑名单禁止 → 黑名单优先（拒绝）。
     * 两个集合冲突时，黑名单（deny）优先于白名单（allow）。
     */
    it('白名单允许 + 黑名单禁止 → 黑名单优先拒绝', async () => {
        const result = await executeTool(call, {
            ...baseContext,
            allowedToolNames: new Set([probe]),    // 白名单允许
            disallowedToolNames: new Set([probe]),  // 但黑名单也禁止
        })
        expect(result.denied).toBe(true)
        expect(result.result.success).toBe(false)
        expect(result.result.error).toContain('disallowedTools 列表禁止')
    })

    /**
     * 白名单拒绝 → 直接拒绝（不进入黑名单检查）。
     * 白名单检查在前，黑名单检查在后，两者短路。
     */
    it('白名单拒绝 → 直接拒绝（不检查黑名单）', async () => {
        const result = await executeTool(call, {
            ...baseContext,
            allowedToolNames: new Set([probe2]),   // 白名单不含 probe
            disallowedToolNames: new Set([probe2]), // 黑名单禁 probe2（不是 probe）
        })
        expect(result.denied).toBe(true)
        expect(result.result.success).toBe(false)
        expect(result.result.error).toContain('不在当前 Agent 的可用工具列表中')
    })

    it('空黑名单 → 不拒绝任何工具', async () => {
        const result = await executeTool(call, {
            ...baseContext,
            disallowedToolNames: new Set(),
        })
        expect(result.result.success).toBe(true)
    })
})
