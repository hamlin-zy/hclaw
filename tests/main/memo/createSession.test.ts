import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Mock 外部依赖（agentManager/repo/resolver/runtimeConfig/logger），只测 memoStore 的编排逻辑
const mocks = vi.hoisted(() => ({
    startCore: vi.fn(async (_params?: {message?: string; conversationTitle?: string}, _origin?: string) => {}),
    create: vi.fn((..._args: unknown[]) => true),
    writeMessages: vi.fn((_convId: string, _msgs: Array<{content: string; metadata?: {commandId: string}}>) => true),
    remove: vi.fn((..._args: unknown[]) => {}),
    primary: {isValid: true},
    resolve: vi.fn((..._args: unknown[]) => null as null | {commandId: string}),
}))
vi.mock('../../../src/main/agent/startAgentCore', () => ({startAgentCore: mocks.startCore}))
vi.mock('../../../src/main/repositories', () => ({
    createConversationRepository: () => ({create: mocks.create, writeMessages: mocks.writeMessages, delete: mocks.remove}),
}))
vi.mock('../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {getPrimaryProvider: () => mocks.primary, getScheme: () => null, getProviders: () => [], getOverride: () => null},
}))
vi.mock('../../../src/main/agent/entityCommandResolver', () => ({
    resolveEntityCommand: mocks.resolve,
}))

let dir: string
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cs-'))
    vi.resetModules()
    vi.doMock('../../../src/main/config', () => ({getHclawDir: () => dir}))
})
afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
    vi.clearAllMocks()
    mocks.primary.isValid = true
})

async function freshStore() {
    const mod = await import('../../../src/main/memo/memoStore')
    return mod.memoStore
}

describe('createSessionFromMemo', () => {
    it('有能力绑定 → 首条消息 /能力名 前缀 + commandId 透传 + start 调用', async () => {
        const store = await freshStore()
        mocks.resolve.mockReturnValueOnce({commandId: 'cmd-123'})
        const item = store.create({workspacePath: 'E:\\p', content: 'fix the bug', title: 'T',
            capability: {type: 'skill', name: 'brainstorming'}})
        const {convId} = await store.createSessionFromMemo(item.id)

        expect(convId).toMatch(/^conv-/)
        // 会话 title 使用 memo.title
        const metaArg = mocks.create.mock.calls[0]![1] as {title: string}
        expect(metaArg.title).toBe('T')
        const startArg0 = mocks.startCore.mock.calls[0]![0] as {conversationTitle?: string; message: string}
        expect(startArg0.conversationTitle).toBe('T')
        expect(mocks.startCore.mock.calls[0]![1]).toBe('memo')
        const msgArg = mocks.writeMessages.mock.calls[0]![1][0]
        expect(msgArg.content).toBe('/brainstorming\nfix the bug')
        expect(msgArg.metadata?.commandId).toBe('cmd-123')
        expect(mocks.startCore).toHaveBeenCalledOnce()
        // 状态标记
        const after = store.findById(item.id)!
        expect(after.status).toBe('processed')
        expect(after.relatedConvId).toBe(convId)
    })

    it('无能力绑定 → 纯正文；解析失败 → 降级不拼前缀', async () => {
        const store = await freshStore()
        const item = store.create({workspacePath: 'E:\\p', content: 'plain task', title: 'T'})
        await store.createSessionFromMemo(item.id)
        expect(mocks.writeMessages.mock.calls[0][1][0].content).toBe('plain task')
        expect(mocks.writeMessages.mock.calls[0][1][0].metadata).toBeUndefined()
        // 旧数据 title 为空时归一化 ''，会话 title 回退到 content 前 50 字符
        const hashDir = fs.readdirSync(path.join(dir, 'data', 'memo'))[0]
        const file = path.join(dir, 'data', 'memo', hashDir, 'memos.json')
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        delete raw[0].title
        fs.writeFileSync(file, JSON.stringify(raw), 'utf8')
        vi.resetModules()
        vi.doMock('../../../src/main/config', () => ({getHclawDir: () => dir}))
        const store2 = await freshStore()
        mocks.create.mockClear()
        await store2.createSessionFromMemo(item.id)
        const metaArg = mocks.create.mock.calls[0]![1] as {title: string}
        expect(metaArg.title).toBe('plain task')
    })

    it('解析失败降级：绑定能力但 resolveEntityCommand 抛错 → 纯正文继续', async () => {
        const store = await freshStore()
        mocks.resolve.mockImplementationOnce(() => {
            throw new Error('gone')
        })
        const item = store.create({workspacePath: 'E:\\p', content: 't', title: 'T',
            capability: {type: 'skill', name: 'gone-skill'}})
        await store.createSessionFromMemo(item.id)
        expect(mocks.writeMessages.mock.calls[0][1][0].content).toBe('t')
    })

    it('附件 → 落库 metadata.attachments + 首轮 content 多模态构建（同 handoff）', async () => {
        const store = await freshStore()
        const src = path.join(dir, 'img.png')
        fs.writeFileSync(src, 'x')
        const att = await store.uploadAttachment({fileName: 'img.png', srcPath: src, mime: 'image/png'})
        const item = store.create({workspacePath: 'E:\\p', content: 'see image', title: 'T', attachments: [att]})
        await store.createSessionFromMemo(item.id)
        // 气泡渲染：metadata.attachments 结构化存储（MessageList 附件卡片来源）
        const msgArg = mocks.writeMessages.mock.calls[0]![1][0] as {metadata?: {attachments?: Array<{path: string; isImage: boolean}>}, content: unknown}
        expect(msgArg.metadata?.attachments).toHaveLength(1)
        expect(msgArg.metadata?.attachments?.[0]).toMatchObject({name: 'img.png', isImage: true, path: item.attachments[0].storedPath})
        // agent 首轮：message 传纯文本（与落库 content 同构 → core 去重生效），
        // 多模态组装由 core 经 messageAttachments 构建
        const startArg = mocks.startCore.mock.calls[0]![0] as {
            message: string
            messageAttachments?: Array<{path: string; name: string}>
        }
        expect(startArg.message).toBe('see image')
        expect(startArg.messageAttachments).toHaveLength(1)
        expect(startArg.messageAttachments?.[0]).toMatchObject({name: 'img.png', path: item.attachments[0].storedPath})
    })

    it('startAgentCore 抛错 → 不标记 processed，错误向上抛', async () => {
        const store = await freshStore()
        mocks.startCore.mockRejectedValueOnce(new Error('worker boom'))
        const item = store.create({workspacePath: 'E:\\p', content: 't', title: 'T'})
        await expect(store.createSessionFromMemo(item.id)).rejects.toThrow('worker boom')
        expect(store.findById(item.id)!.status).toBe('active')
    })

    it('模型未配置 → 抛错且不标记 processed', async () => {
        const store = await freshStore()
        mocks.primary.isValid = false
        const item = store.create({workspacePath: 'E:\\p', content: 't', title: 'T'})
        await expect(store.createSessionFromMemo(item.id)).rejects.toThrow()
        expect(store.findById(item.id)!.status).toBe('active')
    })
})
