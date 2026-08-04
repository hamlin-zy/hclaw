/**
 * 用户命令消息解析测试（渲染层能力徽章依赖）
 *
 * 保护：用户消息气泡中 /能力 渲染为能力徽章（skill 🛠️ / agent 🤖 / command ⚡），
 * 显示名与任务内容来自消息文本，commandId 仅用于类型判定。
 */
import {describe, expect, it} from 'vitest'
import {inferTypeFromCommandId, parseUserCommandContext} from '../../../src/renderer/lib/userCommandParse'

describe('inferTypeFromCommandId（能力类型判定）', () => {
    it('skill 前缀 → skill', () => {
        expect(inferTypeFromCommandId('skill:brainstorming')).toBe('skill')
    })

    it('agent 前缀 → agent', () => {
        expect(inferTypeFromCommandId('agent:code-simplifier')).toBe('agent')
    })

    it('user 前缀 → user（自定义命令）', () => {
        expect(inferTypeFromCommandId('user:my-cmd')).toBe('user')
    })

    it('其他（plugin / 无前缀）→ plugin', () => {
        expect(inferTypeFromCommandId('plugin:foo:bar')).toBe('plugin')
        expect(inferTypeFromCommandId('foo:bar')).toBe('plugin')
    })
})

describe('parseUserCommandContext（徽章显示）', () => {
    it('Ctrl+K 换行分隔：显示名与任务内容来自文本', () => {
        expect(parseUserCommandContext({
            commandId: 'agent:code-simplifier',
            content: '/code-simplifier\n未提交的代码有没有优化空间？',
        })).toEqual({
            commandName: 'code-simplifier',
            commandArgs: '未提交的代码有没有优化空间？',
            type: 'agent',
        })
    })

    it('手动输入空格分隔：任务内容从单行提取', () => {
        expect(parseUserCommandContext({
            commandId: 'skill:brainstorming',
            content: '/brainstorming 我想设计一个功能',
        })).toEqual({
            commandName: 'brainstorming',
            commandArgs: '我想设计一个功能',
            type: 'skill',
        })
    })

    it('无参数命令：无任务内容', () => {
        expect(parseUserCommandContext({
            commandId: 'skill:skills',
            content: '/skills',
        })).toEqual({commandName: 'skills', commandArgs: undefined, type: 'skill'})
    })

    it('多行任务内容：保留换行', () => {
        expect(parseUserCommandContext({
            commandId: 'skill:systematic-debugging',
            content: '/systematic-debugging\n第一行\n第二行',
        })).toEqual({
            commandName: 'systematic-debugging',
            commandArgs: '第一行\n第二行',
            type: 'skill',
        })
    })

    it('多空格参数：仅首个空白作为分隔符', () => {
        expect(parseUserCommandContext({
            commandId: 'agent:code-simplifier',
            content: '/code-simplifier  两个空格',
        })).toEqual({
            commandName: 'code-simplifier',
            commandArgs: '两个空格',
            type: 'agent',
        })
    })

    it('metadata 兜底：文本无内容时用 commandArgs', () => {
        expect(parseUserCommandContext({
            metadata: {commandId: 'skill:systematic-debugging', commandArgs: '点击报错'},
            content: '/systematic-debugging',
        })).toEqual({
            commandName: 'systematic-debugging',
            commandArgs: '点击报错',
            type: 'skill',
        })
    })

    it('无 commandId（非命令消息）返回 null', () => {
        expect(parseUserCommandContext({content: '普通消息'})).toBeNull()
        expect(parseUserCommandContext({})).toBeNull()
    })

    it('插件命令类型判定：user 之外的冒号前缀归为 plugin', () => {
        expect(parseUserCommandContext({
            commandId: 'plugin:demo:build',
            content: '/build',
        })).toEqual({commandName: 'build', commandArgs: undefined, type: 'plugin'})
    })

    describe('降级路径（历史消息 commandId 缺失）', () => {
        const known = {
            skills: ['brainstorming', 'systematic-debugging'],
            agents: ['code-simplifier'],
            userCommands: ['daily-report'],
        }

        it('content 首行命中已知 skill 名 → 渲染为 skill 徽章', () => {
            expect(parseUserCommandContext(
                {content: '/brainstorming\n我想设计一个功能'},
                known,
            )).toEqual({commandName: 'brainstorming', commandArgs: '我想设计一个功能', type: 'skill'})
        })

        it('content 首行命中已知 agent 名 → 渲染为 agent 徽章', () => {
            expect(parseUserCommandContext(
                {content: '/code-simplifier 帮我简化这段代码'},
                known,
            )).toEqual({commandName: 'code-simplifier', commandArgs: '帮我简化这段代码', type: 'agent'})
        })

        it('content 首行命中已知用户命令名 → 渲染为 user 徽章', () => {
            expect(parseUserCommandContext(
                {content: '/daily-report'},
                known,
            )).toEqual({commandName: 'daily-report', commandArgs: undefined, type: 'user'})
        })

        it('未命中任何已知能力 → 返回 null（保持纯文本）', () => {
            expect(parseUserCommandContext({content: '/未知命令 随便说说'}, known)).toBeNull()
        })

        it('不传 known（未启用降级）→ 返回 null', () => {
            expect(parseUserCommandContext({content: '/brainstorming 测试'})).toBeNull()
        })

        it('普通文本（非 / 开头）→ 返回 null', () => {
            expect(parseUserCommandContext({content: '这是一条普通消息'}, known)).toBeNull()
        })
    })
})
