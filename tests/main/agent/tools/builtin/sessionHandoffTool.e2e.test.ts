/**
 * session_handoff 工具 e2e 测试
 *
 * 复用 childConvMessages.e2e.test.ts 的测试模式与目录约定。
 *
 * 说明：本测试聚焦工具定义（sessionHandoffTool.inputSchema）的输入校验逻辑，
 * schema 是纯函数，可直接单测；execute 依赖 agentLoop + LLM 调用，不在单测中
 * 真实执行（避免 mock 整条 agent 链路）。
 */
import {describe, it, expect} from 'vitest'
import {sessionHandoffTool} from '../../../../../src/main/agent/tools/builtin/sessionHandoffTool'

describe('session_handoff Tool', () => {
    it('合法输入通过 schema 校验，title 原样保留', () => {
        const result = sessionHandoffTool.inputSchema.safeParse({
            title: '测试新会话',
            handoffSummary:
                '## 任务目标\n测试任务\n'
                + '## 已完成进度\n无\n'
                + '## 遗留问题\n无\n'
                + '## 下一步计划\n继续\n'
                + '## 关键上下文\n无',
        })
        expect(result.success).toBe(true)
        expect(result.data?.title).toBe('测试新会话')
    })

    it('handoffSummary 为空时应拒绝', () => {
        const result = sessionHandoffTool.inputSchema.safeParse({
            title: '测试',
            handoffSummary: '',
        })
        expect(result.success).toBe(false)
    })

    it('title 为空时应拒绝', () => {
        const result = sessionHandoffTool.inputSchema.safeParse({
            title: '',
            handoffSummary: 'test',
        })
        expect(result.success).toBe(false)
    })

    it('capability 可选，合法值通过校验并原样保留', () => {
        const result = sessionHandoffTool.inputSchema.safeParse({
            title: '测试',
            handoffSummary: '## 任务目标\n继续任务',
            capability: 'brainstorming',
        })
        expect(result.success).toBe(true)
        expect(result.data?.capability).toBe('brainstorming')
    })

    it('capability 为空串时仍通过（拼接逻辑跳过）', () => {
        const result = sessionHandoffTool.inputSchema.safeParse({
            title: '测试',
            handoffSummary: '## 任务目标\n继续任务',
            capability: '',
        })
        expect(result.success).toBe(true)
    })
})
