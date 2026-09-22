/**
 * 两态端到端回归（G1）：实时事件序列 → 真实落库 → 读回重建，块序必须一致。
 *
 * 缺口背景：既有断言全在单侧——要么只到桥接层的调用参数（recordTextChunk 的
 * blockSuffix / turnIndex），要么只到 SQL 层（迁移 051 的触发器）。**没有一条**走完
 * `persistStreamEvent → ConversationPersistence.accumulate/flush → 真实 SQLite 写入
 * → readMessages 读回重建` 再断言块序列。而原缺陷本质恰是「实时正常、重启错乱」的
 * 两态口径差：实时态按内存 contentBlocks 渲染正常，重启重建态按 DB sequence +
 * messageBlocksHelper 的 think 边界切段 fallback 组装 → 段号漂移的块顺序被暴露。
 *
 * 判别力：把「修复前的段号派生实现」放进来会红——同轮 think 被 text 切成两个 id
 * （think-…-12 / think-…-13）、text 被切成两个 id，读回 contentBlocks 出现 4 个块
 * 而非 2 个；且 think 尾部碎片排在 text 之后（顺序断言同时失败）。
 *
 * 隔离：与 tests/main/repositories/messageBlocksImmutable.test.ts 同款——config 与
 * hclawPaths 双 mock 重定向到 os.tmpdir()，绝不触碰真实 ~/.hclaw/data/hclaw.db。
 */
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-twostate-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩

import {closeDatabase, getDatabase, runMigrations} from '../../../src/main/repositories/sqlite'
import {ConversationPersistence} from '../../../src/main/persistence/conversationPersistence'
import {persistStreamEvent, resetBridgeMsgState} from '../../../src/main/persistence/streamBridge'
import {createConversationRepository} from '../../../src/main/repositories'
import type {PendingAssistantMsg} from '../../../src/main/agent/manager.types'
import type {AgentStreamEvent} from '../../../src/main/agent/stream'
import type {Message} from '../../../src/shared/types'

const CONV_ID = 'conv-twostate'
const repo = createConversationRepository()

beforeAll(() => {
    const db = getDatabase()   // 先建连接（runMigrations 要求 db 非空）
    runMigrations()
    db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(CONV_ID, '', '{}', 1, 1)
})

afterAll(() => { closeDatabase() })

interface ToolCallLike { id: string; name: string; arguments: Record<string, unknown>; status: string }

function pending(toolCalls: ToolCallLike[] = []): PendingAssistantMsg {
    return {id: 'unused', toolCalls} as unknown as PendingAssistantMsg
}

/** 走真实落库路径：桥接 → 累积 → 显式 flush（同步写库）→ 读回重建。 */
function driveAndReadBack(msgId: string, events: AgentStreamEvent[]): Message {
    resetBridgeMsgState(msgId)
    const p = new ConversationPersistence(repo as never)
    p.ensureMessageRow(CONV_ID, msgId, 1000)
    for (const ev of events) persistStreamEvent(p, CONV_ID, msgId, pending(tcFor(ev)), ev)
    p.flush(CONV_ID)              // 真实写库（绕过 30s 节流窗口）
    p.clearConversation(CONV_ID)  // 释放 flush 定时器，防测试进程悬挂
    const msg = repo.readMessages(CONV_ID).find(m => m.id === msgId)
    expect(msg, `读回消息 ${msgId} 应存在（落库路径断则此处即红）`).toBeTruthy()
    return msg!
}

/** tool_result/tool_completed 分支需要 pending.toolCalls 里能查到对应 toolCall */
function tcFor(ev: AgentStreamEvent): ToolCallLike[] {
    const id = (ev as {toolCallId?: string}).toolCallId
    if (!id) return []
    return [{id, name: 'bash', arguments: {}, status: 'running'}]
}

describe('G1 两态端到端 — 实时事件 → 真实落库 → 读回重建', () => {
    it('根因序列（同轮 think→text→think→text）落库后读回：1 think + 1 text，think 在 text 之前', () => {
        const msgId = 'msg-twostate-root'
        const msg = driveAndReadBack(msgId, [
            {type: 'thinking', content: '…好'} as AgentStreamEvent,
            {type: 'text', content: '## 结论先行\n\n| '} as AgentStreamEvent,
            {type: 'thinking', content: '，写。'} as AgentStreamEvent,
            {type: 'text', content: '关注面 | …'} as AgentStreamEvent,
        ])

        const blocks = msg.contentBlocks ?? []
        // 1) 块序：恰好 2 块，think 在前
        expect(blocks.map(b => b.type)).toEqual(['think', 'text'])
        // 2) 块 id 为轮次派生（同轮恒一块）
        expect(blocks[0].id).toBe(`think-${msgId}-t0`)
        expect(blocks[1].id).toBe(`text-${msgId}-t0`)
        // 3) 内容：两段思考拼接、两段 chunk 拼接（正文不被切断）
        expect(blocks[0].thinkBlock?.content).toBe('…好，写。')
        expect(blocks[1].text).toBe('## 结论先行\n\n| 关注面 | …')
        expect(msg.content).toBe('## 结论先行\n\n| 关注面 | …')
    })

    it('跨轮（tool_result 收尾）落库后读回：两轮各自 1 think + 1 text，轮次与顺序均保持', () => {
        const msgId = 'msg-twostate-turn'
        const tc: ToolCallLike = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}
        const msg = driveAndReadBack(msgId, [
            {type: 'thinking', content: '第一轮思考'} as AgentStreamEvent,
            {type: 'text', content: '第一轮正文'} as AgentStreamEvent,
            {type: 'tool_use', toolCall: tc} as unknown as AgentStreamEvent,
            {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}} as unknown as AgentStreamEvent,
            {type: 'thinking', content: '第二轮思考'} as AgentStreamEvent,
            {type: 'text', content: '第二轮正文'} as AgentStreamEvent,
        ])

        const blocks = msg.contentBlocks ?? []
        // tool_result 块读回时只回填到对应 tool_use（不单独进 contentBlocks）
        expect(blocks.map(b => b.type)).toEqual(['think', 'text', 'tool_use', 'think', 'text'])
        expect(blocks.map(b => b.turnIndex)).toEqual([0, 0, 0, 1, 1])
        expect(blocks.filter(b => b.type === 'think').map(b => b.thinkBlock?.content))
            .toEqual(['第一轮思考', '第二轮思考'])
        expect(blocks.filter(b => b.type === 'text').map(b => b.text))
            .toEqual(['第一轮正文', '第二轮正文'])
        // 同轮内 think 恒在 text 之前（逐轮检查）
        for (const turn of [0, 1]) {
            const inTurn = blocks.filter(b => b.turnIndex === turn && (b.type === 'think' || b.type === 'text'))
            expect(inTurn.map(b => b.type)).toEqual(['think', 'text'])
        }
    })

    it('判别力探针（反事实样本）：修复前的「段号漂移」落库形态会被上面两条断言判红', () => {
        // 本用例不改生产代码，只把「修复前的落库形态」按现场根因手工落进临时库
        // （think 被 text 切成 think-…-12 / think-…-13，text 被切成 text-…-31 /
        //  text-…-32，sequence 按事件到达顺序分配），再走同一条 readMessages 读回路径。
        // 结果 4 块、think 在 text 之间 → 上面两条用例的
        // `toEqual(['think','text'])` / `toHaveLength(1)` 必然失败。
        const msgId = 'msg-twostate-legacy'
        const db = getDatabase()
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, metadata) VALUES (?, ?, ?, ?, ?)')
            .run(msgId, CONV_ID, 'assistant', 1000, '{}')
        const ins = db.prepare(
            'INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        const thinkData = (id: string, content: string) =>
            JSON.stringify({id, content, status: 'thinking', timestamp: 1000})
        ins.run(`think-${msgId}-12`, msgId, 'think', '…好', thinkData(`think-${msgId}-12`, '…好'), 0, 1000, 0)
        ins.run(`text-${msgId}-31`, msgId, 'text', '## 结论先行\n\n| ', null, 1, 1000, 0)
        ins.run(`think-${msgId}-13`, msgId, 'think', '，写。', thinkData(`think-${msgId}-13`, '，写。'), 2, 1000, 0)
        ins.run(`text-${msgId}-32`, msgId, 'text', '关注面 | …', null, 3, 1000, 0)

        const msg = repo.readMessages(CONV_ID).find(m => m.id === msgId)
        expect(msg).toBeTruthy()
        const blocks = msg!.contentBlocks ?? []
        expect(blocks.map(b => b.type)).toEqual(['think', 'text', 'think', 'text'])
        expect(blocks.filter(b => b.type === 'think')).toHaveLength(2)
        expect(blocks.filter(b => b.type === 'text')).toHaveLength(2)
    })
})
