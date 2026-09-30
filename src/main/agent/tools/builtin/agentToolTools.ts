/**
 * 有效工具集装配（纯函数）
 *
 * 供 Agent Worker 侧在「Agent 定义已带基础白名单」之上叠加调用方补充的 additionalTools 时使用：
 * 把补充项解析为真实工具名、按全局/Agent 级黑名单过滤、并对未生效项产出提示。
 *
 * ── 设计约束 ────────────────────────────────────────────────────
 * - 纯函数：不读全局状态，registryNames / disallowedTools / agentName 全部由参数注入，便于单测。
 * - 依赖闭包禁引 electron（本目录模块跑在 Agent Worker 线程）。
 * - 判定顺序固定为：不限制判定 → 黑名单集合构建 → 逐项解析/拦截/收录（顺序影响结果，不可调换）。
 *
 * ── 语义要点 ────────────────────────────────────────────────────
 * - baseTools 为 undefined / [] / ['*'] 时视为「未限制」，原样返回不做并集——
 *   否则会把「全部工具」缩窄成「仅 base + additional 的并集」。
 * - baseTools 中的条目原样保留（不解析、不做黑名单校验）：下游 filterToolsForAgent 会再解析一次，幂等。
 * - 只有 additionalTools 需要解析与校验；无法解析（未注册/名称歧义）与命中黑名单的项被丢弃，
 *   但会各自生成一条 notices，交由调用方提示用户。
 */

import {GLOBAL_DISALLOWED_TOOLS} from '../filter'
import {parseToolSpec, resolveToolName} from '../toolNameResolver'
import {getAgentToolRestrictions} from '../../agentTypes/configs'

export interface ResolveEffectiveToolsParams {
    /** 基础白名单（Agent 定义自带）。undefined / [] / ['*'] 表示未限制 */
    baseTools?: string[]
    /** 调用方补充的工具（可含别名与未注册项） */
    additionalTools?: string[]
    /**
     * Agent 名称，同时用于 notice 文案与 getAgentToolRestrictions() 查表。
     *
     * 注意：该注册表以「短类型名」为键，而调用方传的是「显示名」，故查表当前
     * 恒兜底 General（类型级黑名单在此路径为空）。此行为刻意与运行时保持一致，
     * 类型映射缺陷另行修复——本函数不做名字归一。
     */
    agentName: string
    /** Agent / 会话级显式黑名单 */
    disallowedTools: string[]
    /** 当前已注册的工具名清单（由调用方注入） */
    registryNames: string[]
}

export interface ResolveEffectiveToolsResult {
    /** 生效的工具集；未限制时原样回传 baseTools（可能为 undefined） */
    tools?: string[]
    /** 未生效项提示（空数组表示全部生效） */
    notices: string[]
}

/**
 * 装配最终生效的工具集。
 *
 * @param params 见 ResolveEffectiveToolsParams
 */
export function resolveEffectiveTools(
    params: ResolveEffectiveToolsParams,
): ResolveEffectiveToolsResult {
    const {baseTools, additionalTools, agentName, disallowedTools, registryNames} = params

    // 1. 未限制判定：[] 或 ['*'] 均表示「不限制」，此时不得做并集缩窄
    const base = baseTools ?? []
    const unrestricted = base.length === 0 || (base.length === 1 && base[0] === '*')

    // 2. 未限制，或没有可补充项 → 原样返回
    if (unrestricted || !additionalTools?.length) {
        return {tools: baseTools, notices: []}
    }

    // 3. 黑名单集合（分列，便于 notice 归因准确）：
    //    同步点：本段镜像 filter.ts 的第 1 层（全局黑名单 GLOBAL_DISALLOWED_TOOLS）与第 3 层
    //    （agent 级 disallowedTools）；下方 getAgentToolRestrictions 一行对应 loop/setup.ts 的
    //    类型级过滤（filterToolsByAgentType）。任一处层级语义变更时须同步本段。
    //    全局字面集合 ／ Agent 级（显式 disallowedTools ∪ Agent 类型限制，均解析为真实工具名，解析失败项丢弃）
    const globalBlocked = new Set<string>(GLOBAL_DISALLOWED_TOOLS)
    const agentBlocked = new Set<string>()
    const addAgentBlocked = (specs: string[] | undefined): void => {
        for (const spec of specs ?? []) {
            const name = resolveToolName(parseToolSpec(spec).toolName, registryNames)
            if (name !== undefined) agentBlocked.add(name)
        }
    }
    addAgentBlocked(disallowedTools)
    addAgentBlocked(getAgentToolRestrictions(agentName).disallowed)

    // 4. 逐项解析与拦截（归因分列：全局禁用 ≠ 该 Agent 黑名单）
    const valid: string[] = []
    const notices: string[] = []
    for (const spec of additionalTools) {
        const name = resolveToolName(spec, registryNames)
        if (name === undefined) {
            notices.push(`${spec}（未注册或名称歧义）`)
            continue
        }
        if (globalBlocked.has(name)) {
            notices.push(`${spec}（全局禁用）`)
            continue
        }
        if (agentBlocked.has(name)) {
            notices.push(`${spec}（被 ${agentName} 的黑名单拦截）`)
            continue
        }
        valid.push(name)
    }

    // 5. 并集去重（valid 存解析后的真实名，别名在此归一）
    return {tools: [...new Set([...base, ...valid])], notices}
}

/**
 * 将 notices 渲染为追加到工具集提示末尾的文案。
 *
 * 空数组返回空串（调用方无需分支判断）。
 */
export function formatToolsNotice(notices: string[]): string {
    if (notices.length === 0) return ''
    return `\n\n[工具集提示] additionalTools 未生效：${notices.join('、')}。其余工具已正常生效。`
}
