/**
 * session_handoff 工具 — 附件支持测试
 *
 * 验证：
 * 1. inputSchema 支持可选 attachments（path/name/mimeType）
 * 2. 带 attachments 时：落库 user 消息 metadata.attachments（AttachmentPreview 渲染结构），
 *    content 保持纯文本（/capability 前缀 + 总结）
 * 3. session_handoff_start 首轮消息 content 由 buildUserHistoryContent 构建（多模态），
 *    且与跨 turn 历史重建（execution.ts 同一共享函数）输出深度一致 → KV cache 前缀保持
 *
 * mock 边界：repositories、runtimeConfigManager、worker_threads（捕获 session_handoff_start payload）
 */
import {describe, it, expect, vi, beforeAll, afterAll, beforeEach} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const {createMock, readMetaMock, writeMessagesMock, postMessageMock} = vi.hoisted(() => ({
    createMock: vi.fn((_convId: string, _meta: Record<string, unknown>) => true),
    readMetaMock: vi.fn((_convId: string) => ({workspacePath: '/ws'} as Record<string, unknown> | null)),
    writeMessagesMock: vi.fn((_convId: string, _messages: unknown[]) => true),
    postMessageMock: vi.fn((_msg: unknown) => undefined),
}))

vi.mock('worker_threads', () => ({
    parentPort: {postMessage: postMessageMock},
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
import {buildUserHistoryContent} from '../../../../../src/main/agent/utils/userContentBuilder'

// 1x1 红色 PNG（真实文件，供 base64 读取）
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
)

describe('session_handoff Tool — 附件支持', () => {
    let tmpDir: string
    let imgPath: string

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-att-'))
        imgPath = path.join(tmpDir, 'shot.png')
        fs.writeFileSync(imgPath, PNG_BYTES)
    })
    afterAll(() => {
        fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    beforeEach(() => {
        vi.clearAllMocks()
        createMock.mockReturnValue(true)
        readMetaMock.mockReturnValue({workspacePath: '/ws'})
        writeMessagesMock.mockReturnValue(true)
    })

    const baseArgs = {
        title: '交接新会话',
        handoffSummary:
            '## 任务目标\n测试\n## 已完成进度\n无\n## 遗留问题\n无\n## 下一步计划\n继续\n## 关键上下文\n无',
    }
    type ExecCtx = Parameters<typeof sessionHandoffTool.execute>[1]
    const makeCtx = (conversationId: string) => ({conversationId}) as unknown as ExecCtx

    it('inputSchema 接受可选 attachments', () => {
        const result = sessionHandoffTool.inputSchema.safeParse({
            title: 't',
            handoffSummary: 's',
            attachments: [{path: '/a/x.png', name: 'x.png'}],
        })
        expect(result.success).toBe(true)
    })

    it('带附件：落库 content 为纯文本，metadata.attachments 为结构化 Attachment 数组', async () => {
        const result = await sessionHandoffTool.execute(
            {...baseArgs, attachments: [{path: imgPath, name: 'shot.png', mimeType: 'image/png'}]},
            makeCtx('conv-src'),
        )

        expect(result.success).toBe(true)
        const [, msgs] = writeMessagesMock.mock.calls[0] as [string, Array<Record<string, any>>]
        const userMsg = msgs[0]
        expect(userMsg.content).toBe(baseArgs.handoffSummary)
        expect(userMsg.metadata.attachments).toHaveLength(1)
        expect(userMsg.metadata.attachments[0]).toMatchObject({
            name: 'shot.png', type: 'image/png', path: imgPath, isImage: true, size: 0,
        })
        expect(userMsg.metadata.attachments[0].id).toBeTruthy()
    })

    it('首轮消息 content 为多模态构建（图片 base64 + 路径标记），与历史重建共享函数输出深度一致', async () => {
        const atts = [{path: imgPath, name: 'shot.png'}]
        await sessionHandoffTool.execute({...baseArgs, attachments: atts}, makeCtx('conv-src'))

        const start = startPostMsg(startPostCalls())
        expect(start).toBeTruthy()
        expect((start!.messages![0] as {content: unknown}).content).toEqual(
            await buildUserHistoryContent(baseArgs.handoffSummary, atts),
        )
    })

    it('无 attachments 时行为不变：metadata 无 attachments 字段，首轮 content 为纯文本', async () => {
        await sessionHandoffTool.execute(baseArgs, makeCtx('conv-src'))

        const [, msgs] = writeMessagesMock.mock.calls[0] as [string, Array<Record<string, any>>]
        expect(msgs[0].metadata?.attachments).toBeUndefined()
        const start = startPostMsg(startPostCalls())
        expect(start!.messages![0].content).toBe(baseArgs.handoffSummary)
    })

    // ── helpers ──
    function startPostCalls(): Array<{type?: string; messages?: Array<{content: unknown}>}> {
        return postMessageMock.mock.calls.map(c => c[0] as {type?: string; messages?: Array<{content: unknown}>})
    }
    function startPostMsg(calls: Array<{type?: string; messages?: Array<{content: unknown}>}>) {
        return calls.find(m => m.type === 'session_handoff_start')
    }
})
