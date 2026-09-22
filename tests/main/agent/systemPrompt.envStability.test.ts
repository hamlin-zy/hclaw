import {describe, expect, it, vi, afterEach} from 'vitest'

/** 可变环境桩：用于模拟 shell / 终端 / hclawDir / MCP-OCR 元数据漂移 */
const envState = vi.hoisted(() => ({
    hclawDir: '/tmp/hclaw-test',
    shell: {name: 'powershell', shell: 'pwsh', os: 'windows', codePage: '65001'} as {
        name: string
        shell: string
        os: string
        codePage?: string
    },
    terminalName: 'PowerShell',
    mcpMetas: [] as Array<{proxyName: string; rawToolName: string}>,
}))

vi.mock('../../../src/main/config', () => ({
    getHclawDir: () => envState.hclawDir,
}))
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw
// shell / 终端取进程启动时探测的常量：mock 成可控变量以模拟「换机器/换终端」
// 注：用 importOriginal 保留真实模块的副作用（工具注册 → DI 容器填充 ToolRegistry），
//     只替换读取函数；否则 setup.ts 顶层 container.get(ToolRegistry) 会因链断裂而抛错。
vi.mock('../../../src/main/agent/tools/builtin/bashTool', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return {
        ...actual,
        getShellInfo: () => envState.shell,
        getTerminalDisplayName: () => envState.terminalName,
    }
})
// MCP 工具元数据：能力探测（{{mcpOcrStatus}}）的唯一输入源
vi.mock('../../../src/main/agent/mcp/discovery', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return {...actual, getAllMcpToolMeta: () => envState.mcpMetas}
})

import {buildSystemPrompt} from '../../../src/main/agent/systemPrompt'
import {buildSystemPrompt as buildSystemPromptWithCache} from '../../../src/main/agent/loop/setup'
import {buildSystemSignature} from '../../../src/main/agent/loop/controller'

/**
 * 缓存稳定化回归：system 不得包含权限模式与动态日期。
 * anthropicAdapter 以 system 为唯一 cache_control 断点，这两项变化即前缀缓存全失效；
 * 且权限模式属安全决策——完全不下发模型。
 */
describe('systemPrompt 环境段稳定化', () => {
    const baseCtx = {
        workingDir: '/x',
        tools: [],
        permissionMode: 'safe',
        agentType: 'General' as const,
    }

    it('不含权限模式行与权限模式值', async () => {
        const p = await buildSystemPrompt(baseCtx)
        expect(p).not.toContain('权限模式')
        expect(p).not.toContain('safe')
        expect(p).not.toContain('auto')
    })

    it('不含当前日期行（yyyy-MM-dd 模式）', async () => {
        const p = await buildSystemPrompt(baseCtx)
        expect(p).not.toContain('当前日期')
        expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    })

    it('不同权限模式 / 不同日期的上下文输出 byte-equal', async () => {
        const a = await buildSystemPrompt({...baseCtx, permissionMode: 'safe'})
        const b = await buildSystemPrompt({...baseCtx, permissionMode: 'auto'})
        expect(a).toBe(b)
    })

    it('保留稳定环境项：平台/终端/操作系统/Node/工作目录', async () => {
        const p = await buildSystemPrompt(baseCtx)
        expect(p).toContain('**平台**')
        expect(p).toContain('**终端**')
        expect(p).toContain('**操作系统**')
        expect(p).toContain('**Node.js**')
        expect(p).toContain('**工作目录**: /x')
    })
})

// ═══════════════════════════════════════════════════════════════════
//  P0-3 / P1-10 / P1-11 / P1-13：system 字节确定性（方案 A：固化现状）
//
//  ★ 方案 A 的契约（本组测试即该契约的固化）：
//    system 正文含 shell / Node 版本 / hclawDir / MCP-OCR 等易变字段，
//    但这些字段 RENDER 在构建时、不进入 buildSystemSignature 键集
//    （controller.ts:261-263 仅 {workingDir, agentType, customInstructions, languageSection?}）。
//    因此：字段变化 → 签名不变 → setup.ts:481 复用既有字节 → 前缀冻结、缓存不破。
//
//  ★ 若将来要改成「扩签名」（方案 B：环境字段入键、变化即重建新字节），
//    必须先改本文件的「复用既有 system 字节」用例——它会因此变红，这是有意设计。
// ═══════════════════════════════════════════════════════════════════

const BASE_BUILD_PARAMS = {
    commandContext: null,
    agentDefinition: undefined,
    workingDir: '/x',
    availableToolDefinitions: [],
    currentPermissionMode: 'auto' as const,
    customInstructions: undefined,
    agentType: 'General',
    agentTemplates: undefined,
}

function resetEnv() {
    envState.hclawDir = '/tmp/hclaw-test'
    envState.shell = {name: 'powershell', shell: 'pwsh', os: 'windows', codePage: '65001'}
    envState.terminalName = 'PowerShell'
    envState.mcpMetas = []
}

/** 模拟「换机器/换终端/换 Node/新增 MCP-OCR 工具/hclaw 目录迁移」一整组环境漂移 */
function driftEnv() {
    envState.hclawDir = '/tmp/hclaw-moved'
    envState.shell = {name: 'bash', shell: '/bin/bash', os: 'macos'}
    envState.terminalName = 'Bash'
    envState.mcpMetas = [{proxyName: 'm_srv_ocr', rawToolName: 'ocr_image'}]
}

describe('system prompt 字节确定性（P0-3，方案 A）', () => {
    // 与本文件顶部的 baseCtx 同构（该变量作用域限于前一个 describe，这里重建一份）
    const baseCtx = {workingDir: '/x', tools: [], permissionMode: 'safe', agentType: 'General' as const}
    afterEach(() => resetEnv())

    it('同参数两次调用逐字节相等（无隐藏随机/时间因素）', async () => {
        const a = await buildSystemPrompt(baseCtx)
        const b = await buildSystemPrompt(baseCtx)
        expect(a).toBe(b)
        // 缓存版构建入口同样确定性
        const c = await buildSystemPromptWithCache({...BASE_BUILD_PARAMS, cachedSystemPrompt: null, cacheSignature: null})
        const d = await buildSystemPromptWithCache({...BASE_BUILD_PARAMS, cachedSystemPrompt: null, cacheSignature: null})
        expect(c).toBe(d)
    })

    it('不含毫秒时间戳 / yyyy-MM-dd 当前日期 / UUID / 13 位毫秒戳', async () => {
        const p = await buildSystemPrompt(baseCtx)
        expect(p).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{1,3}/)          // 毫秒时间
        expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/)                    // yyyy-MM-dd
        expect(p).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i) // UUID
        expect(p).not.toMatch(/\b1[6-9]\d{11}\b/)                     // Date.now() 13 位毫秒戳
    })

    it('判别力自检：shell / 终端 / Node 版本 / hclawDir / MCP-OCR 确实进入正文（无缓存重建时字节改变）', async () => {
        const before = await buildSystemPromptWithCache({...BASE_BUILD_PARAMS, cachedSystemPrompt: null, cacheSignature: null})
        expect(before).toContain('pwsh')
        expect(before).toContain(process.version)

        driftEnv()
        const savedVersion = process.version
        Object.defineProperty(process, 'version', {value: 'v0.0.0-test', configurable: true})
        try {
            const after = await buildSystemPromptWithCache({...BASE_BUILD_PARAMS, cachedSystemPrompt: null, cacheSignature: null})
            expect(after).not.toBe(before)          // 字段真的在字节里（否则下面的"复用"断言恒真）
            expect(after).toContain('/bin/bash')
            expect(after).toContain('v0.0.0-test')
            expect(after).toContain('/tmp/hclaw-moved')
            expect(after).toContain('优先调用对应 MCP 工具提取内容')
        } finally {
            Object.defineProperty(process, 'version', {value: savedVersion, configurable: true})
        }
    })

    it('★ 签名相同 → 复用既有 system 字节：shell / Node / hclawDir / MCP-OCR 变化不改写前缀（现状契约）', async () => {
        const cachedBytes = await buildSystemPromptWithCache({...BASE_BUILD_PARAMS, cachedSystemPrompt: null, cacheSignature: null})
        const sig = buildSystemSignature('/x', 'General', undefined, undefined)

        driftEnv()
        const savedVersion = process.version
        Object.defineProperty(process, 'version', {value: 'v0.0.0-test', configurable: true})
        try {
            const reused = await buildSystemPromptWithCache({
                ...BASE_BUILD_PARAMS,
                cachedSystemPrompt: cachedBytes,
                cacheSignature: sig,
                cachedSignature: sig,
            })
            // 环境已漂移，但签名未变 → 原样返回 DB 内旧字节（前缀冻结、缓存命中）
            expect(reused).toBe(cachedBytes)
            expect(reused).toContain('pwsh')          // 旧终端，而非 /bin/bash
            expect(reused).not.toContain('/bin/bash')
            expect(reused).not.toContain('v0.0.0-test')
        } finally {
            Object.defineProperty(process, 'version', {value: savedVersion, configurable: true})
        }
    })
})

describe('权限模式与 system 字节（P1-13）', () => {
    const baseCtx = {workingDir: '/x', tools: [], permissionMode: 'safe', agentType: 'General' as const}
    afterEach(() => resetEnv())

    it('safe / auto / plan 三模式输出逐字节相等（模式不进 system）', async () => {
        const safe = await buildSystemPrompt({...baseCtx, permissionMode: 'safe'})
        const auto = await buildSystemPrompt({...baseCtx, permissionMode: 'auto'})
        const plan = await buildSystemPrompt({...baseCtx, permissionMode: 'plan'})
        expect(safe).toBe(auto)
        expect(auto).toBe(plan)
    })

    it('输出不含权限模式字样（四道护栏之一：权限模式不下发模型）', async () => {
        for (const mode of ['safe', 'auto', 'plan']) {
            const p = await buildSystemPrompt({...baseCtx, permissionMode: mode})
            expect(p).not.toContain('权限模式')
            expect(p).not.toContain('permissionMode')
            expect(p).not.toContain('PermissionMode')
        }
    })

    /**
     * 「规则内容变化」的可见载体只有 permissionMode（auto 剥离危险规则 / plan 限制写工具，
     * 见 permissions/permissionRule.ts:56-100 的 transitionMode 分支）；SystemPromptContext
     * （systemPrompt.ts:19-40）根本没有规则集合字段，setup.ts:494-503 也只透传 permissionMode。
     * 故三模式等价即覆盖「规则集增删不改变 system 字节」。
     * 若将来把规则渲染进 system（新增规则字段/文本），本断言立即红。
     */
    it('规则集变化（三模式对应三套规则）不改变 system 字节', async () => {
        const snapshot = await buildSystemPrompt({...baseCtx, permissionMode: 'safe'})
        const afterModeSwitch = await buildSystemPrompt({...baseCtx, permissionMode: 'auto'})
        expect(afterModeSwitch).toBe(snapshot)
        // 且正文不含规则语法痕迹（工具名白/黑名单、规则关键字）
        expect(snapshot).not.toMatch(/\ballow(ed)?\s*:|denyList|allowList|permissionRule/i)
    })
})
