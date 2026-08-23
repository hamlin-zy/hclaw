/**
 * session_handoff 工具 execute 的 meta 写入测试
 *
 * 验证交接新会话的 meta 携带 handoffFromConvId（MessageList「←前会话」导航数据源），
 * 且不设置 parentConvId（交接新会话是独立顶层会话，区别于 agent 工具子会话）。
 *
 * mock 边界：runtimeConfigManager（模型配置检查）、repositories（SQLite 仓库）；
 * parentPort 不存在 → 渲染进程通知与 Worker 启动走 catch 分支静默失败（不影响 meta 断言）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const {createMock, readMetaMock, writeMessagesMock} = vi.hoisted(() => ({
    createMock: vi.fn((_convId: string, _meta: Record<string, unknown>) => true),
    readMetaMock: vi.fn((_convId: string) => ({workspacePath: '/ws'} as Record<string, unknown> | null)),
    writeMessagesMock: vi.fn((_convId: string, _messages: unknown[]) => true),
}))

vi.mock('../../../../../src/main/repositories', () => ({
    createConversationRepository: () => ({
        create: createMock,
        readMeta: readMetaMock,
        writeMessages: writeMessagesMock,
    }),
}))

vi.mock('../../../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getPrimaryProvider: () => ({isValid: true}),
    },
}))

import {sessionHandoffTool} from '../../../../../src/main/agent/tools/builtin/sessionHandoffTool'

describe('session_handoff Tool execute — handoffFromConvId 写入', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        createMock.mockReturnValue(true)
        readMetaMock.mockReturnValue({workspacePath: '/ws'})
        writeMessagesMock.mockReturnValue(true)
    })

    const validArgs = {
        title: '交接新会话',
        handoffSummary:
            '## 任务目标\n测试\n## 已完成进度\n无\n## 遗留问题\n无\n## 下一步计划\n继续\n## 关键上下文\n无',
    }
    type ExecCtx = Parameters<typeof sessionHandoffTool.execute>[1]
    const makeCtx = (conversationId: string) => ({conversationId}) as unknown as ExecCtx

    it('meta 记录 handoffFromConvId=来源会话，且不设 parentConvId/isChildSession', async () => {
        const result = await sessionHandoffTool.execute(validArgs, makeCtx('conv-source'))

        expect(result.success).toBe(true)
        expect(createMock).toHaveBeenCalledTimes(1)
        const [convId, meta] = createMock.mock.calls[0]
        expect(convId).toMatch(/^conv-/)
        expect(meta.handoffFromConvId).toBe('conv-source')
        expect(meta.parentConvId).toBeUndefined()
        expect(meta.isChildSession).toBeUndefined()
        expect(meta.workspacePath).toBe('/ws')
    })

    it('无来源会话（conversationId 为空）时 handoffFromConvId 为 undefined', async () => {
        const result = await sessionHandoffTool.execute(validArgs, makeCtx(''))

        expect(result.success).toBe(true)
        const [, meta] = createMock.mock.calls[0]
        expect(meta.handoffFromConvId).toBeUndefined()
    })
})
