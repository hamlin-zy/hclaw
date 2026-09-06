/**
 * session_handoff 工具 execute 的交接迁移测试
 *
 * 验证交接时调用 migrateActiveBatch，把来源会话的活跃批次迁移到新会话。
 * mock 边界：runtimeConfigManager（模型配置检查）、repositories（SQLite 仓库）、
 * taskBatchRepository（迁移函数）；parentPort 不存在 → 渲染进程通知与 Worker
 * 启动走 catch 分支静默失败（不影响迁移断言）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const {createMock, readMetaMock, writeMessagesMock, migrateMock} = vi.hoisted(() => ({
    createMock: vi.fn((_convId: string, _meta: Record<string, unknown>) => true),
    readMetaMock: vi.fn((_convId: string) => ({workspacePath: '/ws'} as Record<string, unknown> | null)),
    writeMessagesMock: vi.fn((_convId: string, _messages: unknown[]) => true),
    migrateMock: vi.fn(),
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

vi.mock('../../../../../src/main/repositories/sqlite/taskBatchRepository', () => ({
    migrateActiveBatch: migrateMock,
}))

import {sessionHandoffTool} from '../../../../../src/main/agent/tools/builtin/sessionHandoffTool'

describe('session_handoff Tool execute — 交接迁移活跃批次', () => {
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

    it('有来源会话时调用 migrateActiveBatch(来源, 新会话)', async () => {
        const result = await sessionHandoffTool.execute(validArgs, makeCtx('conv-source'))

        expect(result.success).toBe(true)
        expect(migrateMock).toHaveBeenCalledTimes(1)
        const [from, to] = migrateMock.mock.calls[0]
        expect(from).toBe('conv-source')
        expect(to).toMatch(/^conv-/)
        expect(to).not.toBe('conv-source')
    })

    it('无来源会话时（conversationId 为空）不调用 migrateActiveBatch', async () => {
        const result = await sessionHandoffTool.execute(validArgs, makeCtx(''))

        expect(result.success).toBe(true)
        expect(migrateMock).not.toHaveBeenCalled()
    })
})
