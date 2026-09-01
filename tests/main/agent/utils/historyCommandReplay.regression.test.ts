/**
 * 命令模板重建回归测试（Task 4 重写）
 *
 * CT（<command-task>）自 Task 4 起是真实持久化消息：controller 主循环前经
 * buildCommandTaskContent 构建并落库，历史重建（convertUserHistoryMessage）
 * 不再重放合成消息。本文件锁定：
 * - convertUserHistoryMessage 恒返回单条消息（1:1）
 * - 旧会话残留的 commandTemplate metadata 不再产生尾随消息（metadata 不影响内容字节）
 * - buildUserHistoryContent 附件构建输出不变式
 */
import {describe, it, expect} from 'vitest'

import {
    convertUserHistoryMessage,
    buildUserHistoryContent,
} from '../../../../src/main/agent/utils/userContentBuilder'

const TEMPLATE = '# 技能模式: systematic-debugging\n\n你正在使用技能 "systematic-debugging"。'

describe('convertUserHistoryMessage（恒 1:1，无重放）', () => {
    it('user 行携带旧 commandTemplate metadata：返回单条，content 不含 <command-task>', async () => {
        const result = await convertUserHistoryMessage({
            id: 'u1',
            role: 'user',
            content: '/systematic-debugging 复现场景',
            metadata: {commandId: 'skill:systematic-debugging', commandTemplate: TEMPLATE},
        })
        expect(result).toHaveLength(1)
        expect(result[0].content).toBe('/systematic-debugging 复现场景')
        expect(String(result[0].content)).not.toContain('<command-task>')
        // metadata 保留收拢（供 restoreCatalogState 等下游消费），不影响内容
        expect((result[0].metadata as Record<string, unknown>).commandId).toBe('skill:systematic-debugging')
    })

    it('普通消息（无 commandTemplate metadata）：恒单条', async () => {
        const result = await convertUserHistoryMessage({
            id: 'u9',
            role: 'user',
            content: '纯文本指令',
            metadata: {commandId: undefined, commandTemplate: undefined} as Record<string, unknown>,
        })
        expect(result).toHaveLength(1)
        expect(result[0].content).toBe('纯文本指令')
    })

    it('★ DB 读回真实形态：commandTemplate 展开在消息顶层（buildMessagesFromRows ...metadata），仍单条', async () => {
        const result = await convertUserHistoryMessage({
            id: 'u11',
            role: 'user',
            content: '/code-simplifier 优化',
            // 真实 DB 读回：metadata 整体展开到顶层，msg.metadata 为 undefined
            commandTemplate: TEMPLATE,
        } as unknown as Parameters<typeof convertUserHistoryMessage>[0])
        expect(result).toHaveLength(1)
        expect(result[0].content).toBe('/code-simplifier 优化')
        expect(String(result[0].content)).not.toContain('<command-task>')
    })

    it('附件 + 命令 metadata 共存：本体走附件构建，恒单条', async () => {
        const result = await convertUserHistoryMessage({
            id: 'u10',
            role: 'user',
            content: '看这个文件',
            metadata: {commandTemplate: TEMPLATE},
            attachments: [{path: '/a/notes.txt', name: 'notes.txt'}],
        })
        expect(result).toHaveLength(1)
        expect(String(result[0].content)).toContain('[附件]')
        expect(String(result[0].content)).toContain('/a/notes.txt')
        expect(String(result[0].content)).not.toContain('<command-task>')
    })
})

describe('buildUserHistoryContent 输出不变式', () => {
    it('附件构建与首轮直传同源：非图片附件输出格式锁定', async () => {
        // 同一输入在「首轮直传」与「重建」两侧都走 buildUserHistoryContent，
        // 此处锁定该函数对非图片附件的输出格式（防止任一侧改格式导致分叉）
        const content = await buildUserHistoryContent('看这个文件', [{path: '/a/notes.txt', name: 'notes.txt'}])
        expect(content).toBe('看这个文件\n\n[附件]\n文件: notes.txt\n路径: /a/notes.txt')
    })
})
