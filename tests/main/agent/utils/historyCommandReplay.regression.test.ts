/**
 * 命令模板跨 turn 缓存一致性回归测试（字节级）
 *
 * 背景：命令轮首轮在 loop/execute.ts LLM 调用时注入 <command-task> 尾随 user
 * 消息但不落库；历史重建（convertUserHistoryMessage）必须重放出逐字节相同的
 * 消息，否则下一轮请求前缀在命令 user 消息后立即分叉 → cached_tokens 归零。
 *
 * 防线设计：首轮侧使用硬编码字面量（非共享函数），同时锁定「重放逻辑」与
 * 「<command-task> 包裹格式」。任何一侧改动导致输出漂移都会在此红灯。
 */
import {describe, it, expect} from 'vitest'

import {
    convertUserHistoryMessage,
    normalizeHistoryMessageOrder,
    buildUserHistoryContent,
} from '../../../../src/main/agent/utils/userContentBuilder'

const TEMPLATE = '# 技能模式: systematic-debugging\n\n你正在使用技能 "systematic-debugging"。'

/** 首轮注入格式的硬编码字面量（与 loop/execute.ts 的注入格式约定锁定） */
const FIRST_TURN_CMD_MESSAGE = `<command-task>\n${TEMPLATE}\n</command-task>`

describe('命令模板跨 turn 前缀一致性（回归）', () => {
    it('命令轮首轮请求 与 次轮重建序列 的重叠前缀逐字节一致', async () => {
        // ── 首轮（命令轮）实际发送给 LLM 的序列 ──
        // execution.ts push 当前消息 → loop/execute.ts 尾随注入
        const firstTurnRequest = [
            {role: 'user', content: '/systematic-debugging 复现场景'},
            {role: 'user', content: FIRST_TURN_CMD_MESSAGE},
        ]

        // ── 次轮（纯文本指令）从 DB 重建 ──
        // DB 行：u1(命令, 含 metadata.commandTemplate) → a1(assistant 回复) → u2(新指令)
        const dbRows = [
            {
                id: 'u1',
                role: 'user',
                content: '/systematic-debugging 复现场景',
                metadata: {commandId: 'skill:systematic-debugging', commandTemplate: TEMPLATE},
            },
            {id: 'a1', role: 'assistant', content: '好的，开始排查'},
            {id: 'u2', role: 'user', content: '第一条用户指令之后的新指令'},
        ]

        const rebuiltUserMessages: Array<{ role: string; content: unknown }> = []
        for (const row of dbRows) {
            if (row.role === 'user') {
                rebuiltUserMessages.push(...await convertUserHistoryMessage(row))
            }
            // assistant 走 convertAssistantHistoryMessage，与本回归无关，略
        }

        // 次轮重建序列 = [u1, cmd1, u2]；其前缀必须与首轮请求逐字节一致
        expect(rebuiltUserMessages).toHaveLength(3)
        expect(rebuiltUserMessages[0]).toMatchObject({role: 'user', content: firstTurnRequest[0].content})
        expect(rebuiltUserMessages[1]).toMatchObject({role: 'user', content: firstTurnRequest[1].content})
        // 尾随消息在 assistant 之前（与首轮注入位置一致）
        expect(rebuiltUserMessages[1].content).toBe(FIRST_TURN_CMD_MESSAGE)
        expect(rebuiltUserMessages[2]).toMatchObject({role: 'user', content: '第一条用户指令之后的新指令'})
    })

    it('普通消息（无 metadata.commandTemplate）不重放尾随消息', async () => {
        const result = await convertUserHistoryMessage({
            id: 'u9',
            role: 'user',
            content: '纯文本指令',
            metadata: {commandId: undefined, commandTemplate: undefined} as Record<string, unknown>,
        })
        expect(result).toHaveLength(1)
        expect(result[0].content).toBe('纯文本指令')
    })

    it('★ DB 读回真实形态：commandTemplate 展开在消息顶层（buildMessagesFromRows ...metadata），仍正确重放', async () => {
        const result = await convertUserHistoryMessage({
            id: 'u11',
            role: 'user',
            content: '/code-simplifier 优化',
            // 真实 DB 读回：metadata 整体展开到顶层，msg.metadata 为 undefined
            commandTemplate: TEMPLATE,
        } as Parameters<typeof convertUserHistoryMessage>[0])
        expect(result).toHaveLength(2)
        expect(result[1].content).toBe(FIRST_TURN_CMD_MESSAGE)
    })

    it('附件 + 命令共存：本体走附件构建，尾随消息仍重放', async () => {
        const result = await convertUserHistoryMessage({
            id: 'u10',
            role: 'user',
            content: '看这个文件',
            metadata: {commandTemplate: TEMPLATE},
            attachments: [{path: '/a/notes.txt', name: 'notes.txt'}],
        })
        expect(result).toHaveLength(2)
        expect(result[0].content).toContain('[附件]')
        expect(result[0].content).toContain('/a/notes.txt')
        expect(result[1].content).toBe(FIRST_TURN_CMD_MESSAGE)
    })

    it('附件构建与首轮直传同源：buildUserHistoryContent 输出不变式', async () => {
        // 同一输入在「首轮直传」与「重建」两侧都走 buildUserHistoryContent，
        // 此处锁定该函数对非图片附件的输出格式（防止任一侧改格式导致分叉）
        const content = await buildUserHistoryContent('看这个文件', [{path: '/a/notes.txt', name: 'notes.txt'}])
        expect(content).toBe('看这个文件\n\n[附件]\n文件: notes.txt\n路径: /a/notes.txt')
    })
})

describe('历史重建顺序规范化（catalog + cmd 重放，回归）', () => {
    /** 构造重建侧消息（模拟 convertUserHistoryMessage 输出 + DB 时间戳排序结果） */
    const u = (id: string, content: string) => ({role: 'user', id, content, metadata: {}})
    const cmdReplay = (id: string, content: string) => ({role: 'user', id: `cmd-replay-${id}`, content})
    const catalog = (id: string, content: string) => ({
        role: 'user', id, content,
        metadata: {sourceKind: 'capability-catalog', catalogDigest: 'd1'},
    })
    const a = (id: string, content: string) => ({role: 'assistant', id, content})

    it('★ 真实 DB 顺序 [u, cmd重放, a, catalog, u2, a2] 规范化为 [u, catalog, a, cmd, u2, a2]', () => {
        // 首轮请求序列（provider 实际缓存的前缀，取自 conv-1d1256d0 trace 实测）：
        //   [u41, catalog, a..., cmd(★每次 LLM 调用尾随注入，始终位于当轮消息末尾)]
        // cmd 重放必须对齐该位置：命令轮 assistant 之后、下一个 user 之前
        const rebuilt = [
            u('u1', '/cmd x'),
            cmdReplay('r1', '<command-task>...</command-task>'),
            a('a1', '第一轮回复'),
            catalog('cat1', '<system-reminder>capabilities...</system-reminder>'),
            u('u2', '第二条指令'),
            a('a2', '第二轮回复'),
        ]
        const normalized = normalizeHistoryMessageOrder(rebuilt)
        expect(normalized.map(m => m.id)).toEqual(['u1', 'cat1', 'a1', 'cmd-replay-r1', 'u2', 'a2'])
    })

    it('无 catalog 时重放移到命令轮段末尾 [u, a, cmd]（对齐首轮尾随注入）', () => {
        const rebuilt = [u('u1', '/cmd x'), cmdReplay('r1', '<command-task>...</command-task>'), a('a1', 'ok')]
        expect(normalizeHistoryMessageOrder(rebuilt).map(m => m.id)).toEqual(['u1', 'a1', 'cmd-replay-r1'])
    })

    it('次轮新发布 catalog（时间戳晚于 a 占位）也归位到 [u2, catalog, a2, cmd2]', () => {
        const rebuilt = [
            u('u1', '/cmd x'),
            cmdReplay('r1', '<command-task>1</command-task>'),
            a('a1', 'r1'),
            catalog('cat1', 'cat1'),
            u('u2', '/cmd y'),
            cmdReplay('r2', '<command-task>2</command-task>'),
            a('a2', 'r2'),
            catalog('cat2', 'cat2'),
        ]
        const normalized = normalizeHistoryMessageOrder(rebuilt)
        expect(normalized.map(m => m.id)).toEqual([
            'u1', 'cat1', 'a1', 'cmd-replay-r1',
            'u2', 'cat2', 'a2', 'cmd-replay-r2',
        ])
    })

    it('命令轮是历史末尾（次轮起点，无后续 user）→ 重放在数组末尾', () => {
        const rebuilt = [
            u('u1', '/cmd x'),
            cmdReplay('r1', '<command-task>...</command-task>'),
            a('a1', 'r1'),
        ]
        expect(normalizeHistoryMessageOrder(rebuilt).map(m => m.id)).toEqual(['u1', 'a1', 'cmd-replay-r1'])
    })

    it('纯文本多轮会话（无 catalog 无命令）顺序不变', () => {
        const rebuilt = [u('u1', 'q1'), a('a1', 'r1'), u('u2', 'q2'), a('a2', 'r2')]
        expect(normalizeHistoryMessageOrder(rebuilt).map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    })
})
