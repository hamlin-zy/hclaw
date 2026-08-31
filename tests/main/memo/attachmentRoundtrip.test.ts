/**
 * Phase 3 决定性实验：真实 repo 链路复现 memoStore 写入
 * userMsg（metadata 含 commandId+attachments）→ writeMessages → readMessages
 * 隔离：vi.mock getHclawDir → tmpdir（同 delta.test.ts 模式）
 */
import {describe, it, expect, vi} from 'vitest'

vi.mock('../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-memo-rt-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {initDatabaseSync} from '../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../src/main/repositories/sqlite/conversationRepository'

describe('memo 附件落库 roundtrip（真实 repo）', () => {
    it('metadata.attachments 应存活 writeMessages → readMessages', async () => {
        initDatabaseSync()
        const repo = new SqliteConversationRepository()
        const convId = 'conv-memo-rt-' + Date.now()
        repo.create(convId, {
            id: convId, title: 't', workspacePath: 'E:\\p',
            createdAt: Date.now(), updatedAt: Date.now(), preview: '', status: 'active',
        } as any)

        const {toMessageAttachments} = await import('../../../src/main/agent/utils/userContentBuilder')
        const rawAttachments = [{path: 'C:\\fake\\memo\\image.png', name: 'image.png'}]
        const messageAttachments = toMessageAttachments(rawAttachments as any)
        const commandId = 'agent:local-ECC@github:agents/code-explorer'
        const content = '/code-explorer\n图中有什么？'
        const userMsg = {
            id: `msg-${Date.now()}-rt`,
            role: 'user' as const,
            content,
            timestamp: Date.now(),
            ...(commandId || messageAttachments.length
                ? {metadata: {
                    ...(commandId ? {commandId} : {}),
                    ...(messageAttachments.length ? {attachments: messageAttachments} : {}),
                }}
                : {}),
        }

        expect(userMsg.metadata?.attachments).toHaveLength(1)

        const {messageToBlocks} = await import('../../../src/main/repositories/sqlite/messageBlockHelper')
        const split = messageToBlocks(userMsg as any, convId)
        console.log('[rt] messageToBlocks.metadata =', JSON.stringify(split.messages[0].metadata)?.slice(0, 400))

        const ok = repo.writeMessages(convId, [userMsg as any])
        expect(ok).toBe(true)

        const {getDatabase} = await import('../../../src/main/repositories/sqlite')
        const raw = (getDatabase().prepare('SELECT id, role, metadata FROM messages WHERE conversation_id = ?').all(convId) as any[])
        console.log('[rt] RAW rows =', JSON.stringify(raw))

        const loaded = repo.readMessages(convId)
        expect(loaded).toHaveLength(1)
        console.log('[rt] loaded[0].metadata =', JSON.stringify(loaded[0].metadata))
        console.log('[rt] loaded[0].attachments =', JSON.stringify((loaded[0] as any).attachments)?.slice(0, 300))
        console.log('[rt] loaded[0].content =', JSON.stringify(loaded[0].content)?.slice(0, 120))
        expect(loaded[0].metadata?.attachments ?? (loaded[0] as any).attachments).toBeTruthy()
    })
})
