// @vitest-environment node
/**
 * executeToolCalls — 串行门（内部自行弹确认的工具）测试
 *
 * 背景：call_mcp_tool / memo_tool(delete) 通过 context.requestConfirmation 弹确认，而
 * pendingPermissionConfirm 是单值槽，批内并行多个会互相覆盖 → 必须串行。但两者
 * 与模式的关系不同：
 * - memo_tool：仅 delete 分支弹确认（add/update/list 不弹）→ delete 类 ≥2 即串行（auto 下同样串行）
 * - call_mcp_tool：仅非 auto 才弹确认 → 仅「非 auto 且合计 ≥2」才串行
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const mock = vi.hoisted(() => ({
    mode: 'safe' as 'safe' | 'auto',
    /** permissionEngine.getRules() 返回值（用于判定 auto 下是否存在 proxy 作用域 ask 规则） */
    rules: [] as Array<{tool: string; action: 'allow' | 'deny' | 'ask'}>,
}))

vi.mock('../../../../src/main/agent/tools/permission', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/main/agent/tools/permission')>()
    return {
        ...actual,
        permissionEngine: {
            getMode: async () => mock.mode,
            getRules: async () => mock.rules,
        },
    }
})

import {executeToolCalls} from '../../../../src/main/agent/loop/execute'

/** 记录并发峰值的假 executor */
function makeToolExecutor() {
    let active = 0
    let maxActive = 0
    return {
        peak: () => maxActive,
        hasConfirmationRequired: () => false,
        execute: async (tc: {id: string; name: string; arguments: Record<string, unknown>}) => {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise((r) => setTimeout(r, 10))
            active--
            return {
                result: {toolCallId: tc.id, toolName: tc.name, result: {success: true, output: ''}},
                events: [],
            }
        },
        processResult: (r: unknown, _tc: unknown, s: unknown) => ({state: s, events: []}),
    }
}

async function run(
    names: Array<string | {name: string; args?: Record<string, unknown>}>,
    mode: 'safe' | 'auto',
    rules: Array<{tool: string; action: 'allow' | 'deny' | 'ask'}> = [],
) {
    mock.mode = mode
    mock.rules = rules
    const executor = makeToolExecutor()
    const toolCalls = names.map((n, i) => {
        const name = typeof n === 'string' ? n : n.name
        const args = typeof n === 'string' ? {} : (n.args ?? {})
        return {id: `tc${i}`, name, arguments: args}
    })
    const gen = executeToolCalls({
        toolExecutor: executor as never,
        collectedToolCalls: toolCalls,
        state: {messages: []} as never,
        workingDir: 'E:/tmp',
        abortSignal: undefined,
        requestConfirmation: undefined,
        askUserQuestion: undefined,
        channelSend: undefined,
        onEvent: undefined,
    })
    let res = await gen.next()
    while (!res.done) res = await gen.next()
    return executor
}

describe('executeToolCalls 串行门', () => {
    beforeEach(() => {
        mock.mode = 'safe'
        mock.rules = []
    })

    it('auto 模式 + 2× memo_tool(delete) → 串行（delete 确认与模式无关）', async () => {
        const executor = await run(
            [{name: 'memo_tool', args: {action: 'delete'}}, {name: 'memo_tool', args: {action: 'delete'}}],
            'auto',
        )
        expect(executor.peak()).toBe(1)
    })

    it('auto 模式 + 2× memo_tool(add) → 并行（仅 delete 弹确认，add 不弹）', async () => {
        const executor = await run(
            [{name: 'memo_tool', args: {action: 'add'}}, {name: 'memo_tool', args: {action: 'add'}}],
            'auto',
        )
        expect(executor.peak()).toBe(2)
    })

    it('auto 模式 + 2× call_mcp_tool → 并行（auto 下不弹确认）', async () => {
        const executor = await run(['call_mcp_tool', 'call_mcp_tool'], 'auto')
        expect(executor.peak()).toBe(2)
    })

    it('★ auto 模式 + 2× call_mcp_tool + proxy 作用域 ask 规则 → 串行（ask 模式无关，工具内仍弹确认）', async () => {
        const executor = await run(['call_mcp_tool', 'call_mcp_tool'], 'auto', [{tool: 'm_github_*', action: 'ask'}])
        expect(executor.peak()).toBe(1)
    })

    it('auto 模式 + 引擎层 ask 规则（call_mcp_tool）→ confirmCount 不重复计数（真管线仍由 hasConfirmationRequired 补串行）', async () => {
        // 注意：此用例只覆盖「串行门 confirmCount 子决策」——引擎层 ask 由 executor 的
        // hasConfirmationRequired 处理，工具内不重复弹确认。真实管线中引擎会对 ask 规则
        // 返回 allowed:false，从而 hasConfirmationRequired=true 使整批仍串行（安全方向）。
        // 此处 stub 了 hasConfirmationRequired=false，故断言为并行。
        const executor = await run(['call_mcp_tool', 'call_mcp_tool'], 'auto', [{tool: 'call_mcp_tool', action: 'ask'}])
        expect(executor.peak()).toBe(2)
    })

    it('safe 模式 + 2× call_mcp_tool → 串行（非 auto 会弹确认）', async () => {
        const executor = await run(['call_mcp_tool', 'call_mcp_tool'], 'safe')
        expect(executor.peak()).toBe(1)
    })

    it('安全模式 + memo_tool(delete) + call_mcp_tool → 串行（确认次数合计 ≥2）', async () => {
        const executor = await run(
            [{name: 'memo_tool', args: {action: 'delete'}}, 'call_mcp_tool'],
            'safe',
        )
        expect(executor.peak()).toBe(1)
    })

    it('两条普通工具 → 并行（串行门不误伤）', async () => {
        const executor = await run(['file_read', 'bash'], 'safe')
        expect(executor.peak()).toBe(2)
    })
})
