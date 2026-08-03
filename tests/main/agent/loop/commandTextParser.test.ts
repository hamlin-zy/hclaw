/**
 * 命令文本解析测试（主进程 Agent 命令识别依赖）
 *
 * 保护：Ctrl+K 弹窗发送的命令消息为换行分隔（/能力\n任务内容），
 * 手动输入为空格分隔（/能力 任务内容）。任何一侧被未来改动破坏都会在此失败。
 */
import {describe, expect, it} from 'vitest'
import {parseCommandText} from '../../../../src/main/agent/loop/commandTextParser'

describe('parseCommandText（Agent 命令识别）', () => {
    it('Ctrl+K 换行分隔：/能力\n任务内容', () => {
        expect(parseCommandText('/code-simplifier\n未提交的代码有没有优化空间？')).toEqual({
            commandName: 'code-simplifier',
            commandArgs: '未提交的代码有没有优化空间？',
        })
    })

    it('手动输入空格分隔：/能力 任务内容', () => {
        expect(parseCommandText('/brainstorming 我想设计一个功能')).toEqual({
            commandName: 'brainstorming',
            commandArgs: '我想设计一个功能',
        })
    })

    it('无参数命令：/能力', () => {
        expect(parseCommandText('/skills')).toEqual({commandName: 'skills', commandArgs: undefined})
    })

    it('任务内容含多行（换行分隔）', () => {
        expect(parseCommandText('/systematic-debugging\n第一行\n第二行')).toEqual({
            commandName: 'systematic-debugging',
            commandArgs: '第一行\n第二行',
        })
    })

    it('任务内容含空格（空格分隔）', () => {
        expect(parseCommandText('/pdf 提取 E:\\workspace\\a.pdf')).toEqual({
            commandName: 'pdf',
            commandArgs: '提取 E:\\workspace\\a.pdf',
        })
    })

    it('任务内容多个空格：仅首个空白作为分隔符', () => {
        expect(parseCommandText('/agent  a  b')).toEqual({commandName: 'agent', commandArgs: 'a  b'})
    })

    it('非命令消息（不以 / 开头）返回 null', () => {
        expect(parseCommandText('普通消息')).toBeNull()
        expect(parseCommandText('')).toBeNull()
        expect(parseCommandText('  ')).toBeNull()
    })

    it('单独斜杠无效命令返回 null', () => {
        expect(parseCommandText('/')).toBeNull()
    })

    it('消息前后空白被忽略', () => {
        expect(parseCommandText('  /skill\n任务  ')).toEqual({
            commandName: 'skill',
            commandArgs: '任务',
        })
    })
})
