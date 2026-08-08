/**
 * 子会话完整执行过程持久化 — 端到端集成测试
 *
 * 验证 agentTool 的累积器（childConvMessages）与 SqliteConversationRepository
 * 的真实读写链路（单条消息模式）：
 * - 模拟子 Agent 的典型事件流（思考 → 工具调用 → 文本 → 多轮）
 * - 整个运行累积为一条固定 id 的 assistant 消息（1 指令 + 1 助手气泡）
 * - 增量落库 UPSERT 同一 id（无重复消息）
 * - readMessages 读出后消息结构与主会话一致（contentBlocks 完整保留
 *   思考/工具调用/正文，UI 复用同一渲染管线）
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 下的独立临时目录。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {AgentStreamEvent} from '../../../../../src/main/agent/stream'

vi.mock('../../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-childconv-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../../src/main/repositories/sqlite/conversationRepository'
import {
    createChildConvAccumulator,
    handleChildEvent,
    flushAccumulatorMessage,
    finalizeChildConv,
} from '../../../../../src/main/agent/tools/builtin/childConvMessages'

// ─── 事件工厂 ──────────────────────────────────────────

const thinking = (content: string): AgentStreamEvent => ({type: 'thinking', content})
const text = (content: string): AgentStreamEvent => ({type: 'text', content})
const toolUse = (id: string, name: string, args: Record<string, unknown> = {}): AgentStreamEvent => ({
    type: 'tool_use', toolCall: {id, name, arguments: args},
})
const toolResult = (id: string, output: string): AgentStreamEvent => ({
    type: 'tool_result', toolCallId: id, toolName: 'bash', result: {success: true, output},
})

const CONV_ID = 'conv-child-e2e'

/** 模拟 agentTool 事件循环的累积器驱动（与 agentTool.ts 相同模式） */
function driveAccumulator(events: AgentStreamEvent[], repo: SqliteConversationRepository) {
    const acc = createChildConvAccumulator(CONV_ID)
    for (const event of events) {
        const shouldFlush = handleChildEvent(acc, event)
        if (shouldFlush) {
            flushAccumulatorMessage(acc, repo, CONV_ID, false)
        }
    }
    finalizeChildConv(acc, repo, CONV_ID)
    return acc
}

let repo: SqliteConversationRepository

beforeEach(() => {
    repo = new SqliteConversationRepository()
    const db = getDatabase()
    // 每个用例独立表结构：DROP 后重建，避免跨用例数据残留
    // （与 conversationRepository.delta.test.ts 相同的隔离模式）
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        timestamp INTEGER NOT NULL, ended_at INTEGER, metadata TEXT, llm_stats TEXT,
        is_partial INTEGER NOT NULL DEFAULT 0
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS message_blocks (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL,
        content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER
    )`)
    repo.create(CONV_ID, {
        id: CONV_ID,
        title: 'child',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        preview: '',
        status: 'active',
        parentConvId: 'conv-parent',
        isChildSession: true,
        sourceCapability: {type: 'agent', name: 'Implementer Agent'},
        sourceTask: 'task',
        workspacePath: '',
    } as unknown as import('@shared/types').ConversationMeta)
    repo.writeMessages(CONV_ID, [{
        id: 'msg-user', role: 'user', content: '完成子任务', timestamp: 1000,
    }])
})

afterEach(() => {
    closeDatabase()
})

describe('子会话完整执行过程持久化（端到端 — 单条消息模式）', () => {
    it('单次运行 = 1 指令 + 1 助手消息，读回后完整保留执行过程', () => {
        driveAccumulator([
            thinking('分析任务'),
            toolUse('t1', 'grep', {pattern: 'foo'}),
            toolResult('t1', 'match1'),
            text('最终回答：找到 1 处匹配'),
        ], repo)

        const msgs = repo.readMessages(CONV_ID)
        expect(msgs).toHaveLength(2) // user + 1 条 assistant

        const assistant = msgs[1]
        expect(assistant.role).toBe('assistant')
        expect(assistant.id).toMatch(/^msg-\d+-[a-z0-9]{6}$/)
        expect(assistant.content).toBe('最终回答：找到 1 处匹配')
        expect(assistant.endedAt).toBeDefined()

        // contentBlocks 保留完整时序：think → tool_use → text
        const types = assistant.contentBlocks!.map(b => b.type)
        expect(types).toEqual(['think', 'tool_use', 'text'])
        expect(assistant.contentBlocks![0].thinkBlock?.content).toBe('分析任务')
        expect(assistant.contentBlocks![1].toolCall?.name).toBe('grep')
        expect(assistant.contentBlocks![1].toolCall?.result?.output).toBe('match1')
        expect(assistant.contentBlocks![2].text).toBe('最终回答：找到 1 处匹配')
    })

    it('多轮：全部累积到同一条消息，无重复气泡', () => {
        driveAccumulator([
            // 轮 1：思考 + 工具
            thinking('先查目录'),
            toolUse('t1', 'bash', {command: 'ls'}),
            toolResult('t1', 'a.ts\nb.ts'),
            // 轮 2：文本（无工具）
            text('目录中有两个文件'),
            // 轮 3：思考 + 工具
            thinking('再读文件'),
            toolUse('t2', 'file_read', {path: 'a.ts'}),
            toolResult('t2', '内容...'),
            text('完成'),
        ], repo)

        const msgs = repo.readMessages(CONV_ID)
        expect(msgs).toHaveLength(2) // user + 1 条 assistant（多轮合并）
        const assistant = msgs[1]
        expect(assistant.content).toBe('目录中有两个文件完成') // 全文拼接（text 事件序）
        // 时间序：think(轮1) → tool_use(轮1) → text(轮2) → think(轮3) → tool_use(轮3) → text(轮3)
        const types = assistant.contentBlocks!.map(b => b.type)
        expect(types).toEqual(['think', 'tool_use', 'text', 'think', 'tool_use', 'text'])
        // 两个工具调用都在同一条消息
        expect(assistant.toolCalls).toHaveLength(2)
        expect(assistant.contentBlocks!.filter(b => b.type === 'tool_use').every(b => b.toolCall?.result)).toBe(true)
    })

    it('并行工具：同轮多个工具共享同一条消息', () => {
        driveAccumulator([
            thinking('并行查两个文件'),
            toolUse('t1', 'file_read', {path: 'a.ts'}),
            toolUse('t2', 'file_read', {path: 'b.ts'}),
            toolResult('t1', 'A'),
            toolResult('t2', 'B'),
            text('两个文件都已读取'),
        ], repo)

        const msgs = repo.readMessages(CONV_ID)
        expect(msgs).toHaveLength(2)
        const assistant = msgs[1]
        expect(assistant.contentBlocks!.filter(b => b.type === 'tool_use')).toHaveLength(2)
        expect(assistant.contentBlocks!.filter(b => b.type === 'tool_use').every(b => b.toolCall?.result)).toBe(true)
    })

    it('无工具纯文本轮：内容完整保留', () => {
        driveAccumulator([
            thinking('简单任务'),
            text('直接回答结果'),
        ], repo)

        const msgs = repo.readMessages(CONV_ID)
        expect(msgs).toHaveLength(2)
        const assistant = msgs[1]
        expect(assistant.contentBlocks!.map(b => b.type)).toEqual(['think', 'text'])
        expect(assistant.content).toBe('直接回答结果')
    })

    it('消息可通过 blocksToMessage 正常还原（UI 渲染路径）', () => {
        driveAccumulator([
            thinking('思考'),
            toolUse('t1', 'bash', {command: 'echo hi'}),
            toolResult('t1', 'hi'),
            text('输出为 hi'),
        ], repo)

        const msgs = repo.readMessages(CONV_ID)
        const assistant = msgs[1]
        // 还原后的消息可直接被 MessageBubble/InterleavedContent 渲染
        expect(assistant.contentBlocks).toBeDefined()
        expect(assistant.toolCalls).toBeDefined()
        expect(assistant.toolCalls![0].result?.output).toBe('hi')
        expect(assistant.contentBlocks!.some(b => b.type === 'think')).toBe(true)
    })
})
