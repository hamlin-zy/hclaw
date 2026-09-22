/**
 * 运行身份归一化契约（resolveRunTraceContext）
 *
 * 背景：子会话存在两条 run 入口 —— agentTool 内联派发（声明 traceContext='subAgent'）
 * 与 Worker 再次激活（用户继续发消息 / 重试 / pendingMessages 续跑）。
 * 后者此前硬编码 traceContext='main'，导致 LoopDetector 豁免失效、handoff 门被评估、
 * 默认模型角色回落 primary、llm-trace 归因错误。
 *
 * 契约：以会话身份的落库真相 meta.isChildSession 为准，在 Worker 启动链路统一归一化，
 * 使两条入口的四项语义（LoopDetector 豁免 / handoff 门豁免 / 默认角色 lightweight /
 * llm-trace 归因）一致。
 *
 * 接线断言用源码文本方式（先例：controller.languageGuardWiring.test.ts，
 * tests/shared/settingsDefaults.test.ts），防回退硬编码。
 */
import {describe, it, expect, vi} from 'vitest'
import {readFileSync} from 'fs'
import {resolve} from 'path'

vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () { return {getById: vi.fn()} }),
}))
vi.mock('../../../../src/main/repositories', () => ({
    createConversationRepository: () => ({readMeta: vi.fn(() => null), updateMeta: vi.fn()}),
    createPermissionRepository: () => ({}),
}))
vi.mock('../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {get: vi.fn(() => null), getJson: vi.fn(() => null), set: vi.fn(), setJson: vi.fn()},
}))

import {defaultRoleForTrace, resolveRunTraceContext} from '@/main/agent/loop/setup'

const WORKER_SOURCE = readFileSync(resolve(process.cwd(), 'src/main/agent/worker.ts'), 'utf8')
const START_CORE_SOURCE = readFileSync(resolve(process.cwd(), 'src/main/agent/startAgentCore.ts'), 'utf8')

describe('resolveRunTraceContext — 运行身份归一化（纯函数契约）', () => {
    it('isChildSession=true → subAgent', () => {
        expect(resolveRunTraceContext(true)).toBe('subAgent')
    })

    it('isChildSession=false → main', () => {
        expect(resolveRunTraceContext(false)).toBe('main')
    })

    it('isChildSession=undefined → main（未声明身份按主会话，保守兜底）', () => {
        expect(resolveRunTraceContext(undefined)).toBe('main')
    })
})

describe('resolveRunTraceContext — 一致性契约（归一化后默认角色随之生效）', () => {
    it('defaultRoleForTrace(subAgent) === lightweight', () => {
        expect(defaultRoleForTrace('subAgent')).toBe('lightweight')
    })

    it('归一化结果可作为 defaultRoleForTrace 输入：子会话 → lightweight，主会话 → primary', () => {
        expect(defaultRoleForTrace(resolveRunTraceContext(true))).toBe('lightweight')
        expect(defaultRoleForTrace(resolveRunTraceContext(false))).toBe('primary')
    })
})

describe('运行身份接线契约（源码文本断言）', () => {
    it('worker.ts 在 agentLoop 调用点使用归一化结果', () => {
        expect(WORKER_SOURCE).toContain('resolveRunTraceContext(params.isChildSession)')
        expect(WORKER_SOURCE).toContain("from './loop/setup'")
    })

    it('worker.ts 不再硬编码 traceContext: \'main\'（防回退）', () => {
        expect(WORKER_SOURCE).not.toMatch(/traceContext:\s*'main'/)
    })

    it('startAgentCore.ts 下发会话身份 isChildSession（锚定到"以落库真相取值"）', () => {
        // 锚点取 startAgentCore.ts 中的实际写法（第 304 行）：
        //     isChildSession: meta?.isChildSession === true,
        // 只锚 `isChildSession` 二字会被注释/其他引用蒙混过关；此处钉住取值语义。
        expect(START_CORE_SOURCE).toContain('isChildSession: meta?.isChildSession === true')
    })
})
