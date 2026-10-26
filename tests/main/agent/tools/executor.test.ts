/**
 * executor 结果大小检查单元测试
 *
 * 覆盖：
 * - bash 工具回落到通用阈值（15KB），超过即截断
 * - agent / skill / list_agents 维持豁免（不截断、不加警告）
 * - 阈值内输出原样返回（不添加截断标记）
 * - 超过警告阈值但低于截断阈值时只加警告不截断
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {checkResultSize, resolveToolTimeoutMs} from '../../../../src/main/agent/tools/executor'

// vitest ESM 下 vi.spyOn 无法替换被测模块的命名导入绑定，必须用 vi.mock 工厂替换整个模块
// （对齐 tests/main/agent/tools/builtin/callMcpTool.test.ts 的既有做法）。
vi.mock('@/main/agent/mcp/discovery', () => ({
    getMcpToolMeta: vi.fn(),
}))

function okResult(output: string) {
    return {success: true, output}
}

describe('checkResultSize', () => {
    it('bash 工具输出超过 15KB 时按通用阈值截断', () => {
        // bash 已回落到通用 15KB 阈值
        const big = 'x'.repeat(20 * 1024)
        const result = checkResultSize('bash', okResult(big))
        expect(result.output).toContain('[结果已截断]')
        expect(result.output).toContain('超过 15000 字符限制')
        expect(result.output.length).toBeLessThan(big.length)
    })

    it('bash 工具输出在 15KB 内时不截断', () => {
        const small = 'x'.repeat(10 * 1024)
        const result = checkResultSize('bash', okResult(small))
        expect(result.output).toContain(small)
        expect(result.output).not.toContain('[结果已截断]')
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
import {getMcpToolMeta} from '@/main/agent/mcp/discovery'

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


// ── 别名纠偏后：破坏性工具参数键失败关闭 ──────────────
// 锁定两条路径的分野：只有「请求名未注册 → 纠偏到已注册工具」才触发收紧的键集校验；
// 原生名直调不受该守卫影响（原实现用恒真判断表达同一语义，此处收敛后行为须逐字不变）。
describe('executeTool 别名纠偏 + 破坏性工具参数键守卫', () => {
    const canonical = 'notebook_edit'   // TOOL_NAME_ALIASES['notebookedit'] 的目标工具名
    const aliasedName = 'notebookedit'
    toolRegistry.register(makeTool(canonical, {isDestructive: true}))

    it('别名命中 + 破坏性工具 + 未知参数键 → 拒绝并给出「已解析为」提示', async () => {
        const result = await executeTool(
            {id: 'tc-alias-1', name: aliasedName, arguments: {unknownKey: 1}},
            {...baseContext, permissionMode: 'auto'},
        )
        expect(result.result.success).toBe(false)
        expect(result.result.error).toContain('已解析为')
        expect(result.result.error).toContain('参数键不被支持: unknownKey')
    })

    it('原生名直调 + 相同未知参数键 → 不走别名收紧（由 schema 校验兜底）', async () => {
        const result = await executeTool(
            {id: 'tc-alias-2', name: canonical, arguments: {unknownKey: 1}},
            {...baseContext, permissionMode: 'auto'},
        )
        expect(result.result.error ?? '').not.toContain('已解析为')
        expect(result.result.success).toBe(true)
    })
})

// ── 只读 Agent 的 MCP 原生直调兜底 ──────────────────────
// 上游白名单未保留 call_mcp_tool 时，MCP proxy 以原生名进 tools 数组，
// 不经 call_mcp_tool 的守卫；executor 必须用同一判定函数补齐能力边界。
describe('executor 只读 Agent 的 MCP 原生直调兜底', () => {
    beforeEach(() => {
        vi.mocked(getMcpToolMeta).mockReset()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('readOnlyMcp=true + MCP proxy 名 + 判定 write → 拒绝且不执行', async () => {
        let executed = false
        vi.spyOn(toolRegistry, 'get').mockReturnValue({
            ...makeTool('m_s_set_description'),
            execute: async () => { executed = true; return {success: true, output: ''} },
        } as any)
        vi.mocked(getMcpToolMeta).mockReturnValue({
            proxyName: 'm_s_set_description', serverId: 's', rawToolName: 'set_description',
            rawInputSchema: {type: 'object', properties: {}},
        } as any)
        // permissionMode: 'auto' 保证「守卫缺失」时工具会被真正执行（红灯可观测）
        const r = await executeTool(
            {id: 'c1', name: 'm_s_set_description', arguments: {}},
            {...baseContext, readOnlyMcp: true, permissionMode: 'auto'},
        )
        expect(r.denied).toBe(true)
        expect(executed).toBe(false)
        // 打桩生效实证：executor 的命名导入必须绑定到本 mock（否则读到真实 discovery）
        expect(getMcpToolMeta).toHaveBeenCalledWith('m_s_set_description')
    })

    it('readOnlyMcp=true + MCP proxy 名 + 判定 read → 放行执行', async () => {
        let executed = false
        vi.spyOn(toolRegistry, 'get').mockReturnValue({
            ...makeTool('m_s_explore'),
            execute: async () => { executed = true; return {success: true, output: 'ok'} },
        } as any)
        vi.mocked(getMcpToolMeta).mockReturnValue({
            proxyName: 'm_s_explore', serverId: 's', rawToolName: 'codegraph_explore',
            rawInputSchema: {type: 'object', properties: {}},
        } as any)
        const r = await executeTool(
            {id: 'c2', name: 'm_s_explore', arguments: {}},
            {...baseContext, readOnlyMcp: true, permissionMode: 'auto'},
        )
        expect(executed).toBe(true)
        expect(r.denied).toBeUndefined()
    })

    it('readOnlyMcp 缺省 → MCP 原生直调行为不变（回归）', async () => {
        let executed = false
        vi.spyOn(toolRegistry, 'get').mockReturnValue({
            ...makeTool('m_s_set_description'),
            execute: async () => { executed = true; return {success: true, output: ''} },
        } as any)
        await executeTool(
            {id: 'c3', name: 'm_s_set_description', arguments: {}},
            {...baseContext, permissionMode: 'auto'},
        )
        expect(executed).toBe(true)
    })

    it('readOnlyMcp=true + MCP proxy 名 + meta 缺失 → 回退用 proxy 名判定 write，fail-closed 拒绝', async () => {
        let executed = false
        vi.spyOn(toolRegistry, 'get').mockReturnValue({
            ...makeTool('m_s_set_description'),
            execute: async () => { executed = true; return {success: true, output: ''} },
        } as any)
        // meta 缺失：getMcpToolMeta 返回 undefined → 守卫必须回退用 toolCall.name（proxy 名）判定
        vi.mocked(getMcpToolMeta).mockReturnValue(undefined)
        const r = await executeTool(
            {id: 'c4', name: 'm_s_set_description', arguments: {}},
            {...baseContext, readOnlyMcp: true, permissionMode: 'auto'},
        )
        expect(getMcpToolMeta).toHaveBeenCalledWith('m_s_set_description')
        expect(r.denied).toBe(true)
        expect(executed).toBe(false)
    })
})

// ── file_read 多文件读取的沙盒校验 ──────────────────────
// filePaths 是新增入参：若沙盒层仍只看 args.filePath，多文件读取可绕过路径黑白名单。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {fileReadTool} from '../../../../src/main/agent/tools/builtin/fileReadTool'
import {localSandbox} from '../../../../src/main/sandbox/localSandbox'

describe('executeTool 沙盒校验：file_read 的 filePaths 逐项检查', () => {
    let allowedRoot = ''
    let outsideRoot = ''

    beforeEach(() => {
        toolRegistry.register(fileReadTool)
        allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-sbx-ok-'))
        outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-sbx-out-'))
        fs.writeFileSync(path.join(allowedRoot, 'a.txt'), 'a')
        fs.writeFileSync(path.join(outsideRoot, 'b.txt'), 'b')
        localSandbox.updatePolicy({allowedPaths: [allowedRoot]})
    })

    afterEach(() => {
        localSandbox.updatePolicy({allowedPaths: []})
        fs.rmSync(allowedRoot, {recursive: true, force: true})
        fs.rmSync(outsideRoot, {recursive: true, force: true})
    })

    it('filePaths 中任一路径不在白名单 → 整次调用被 SECURITY BLOCK', async () => {
        const result = await executeTool(
            {
                id: 'tc-sbx-1',
                name: 'file_read',
                arguments: {
                    filePaths: [path.join(allowedRoot, 'a.txt'), path.join(outsideRoot, 'b.txt')],
                },
            },
            {...baseContext, workingDir: allowedRoot},
        )
        expect(result.denied).toBe(true)
        expect(result.result.error).toContain('SECURITY BLOCK')
    })

    it('filePaths 全部在白名单内 → 正常读取（不被沙盒拦截）', async () => {
        const result = await executeTool(
            {
                id: 'tc-sbx-2',
                name: 'file_read',
                arguments: {filePaths: [path.join(allowedRoot, 'a.txt')]},
            },
            {...baseContext, workingDir: allowedRoot},
        )
        expect(result.result.success).toBe(true)
        expect(result.result.output).toContain('a')
    })
})
