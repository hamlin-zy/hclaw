/**
 * 命令文本解析测试（主进程 Agent 命令识别依赖）
 *
 * 保护：Ctrl+K 弹窗发送的命令消息为换行分隔（/能力\n任务内容）；
 * 输入框手打的命令同样保留换行（InputArea 重新拼回时用 /能力\n正文，
 * 正文以 Markdown 标题开头时不能被并进第一行）；纯空格分隔（/能力 任务内容）**依然被支持**。
 * 任何一侧被未来改动破坏都会在此失败。
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

    it('手动输入换行分隔（InputArea 拼回形式）：/能力\n## 标题\n正文', () => {
        expect(parseCommandText('/General\n## 任务目标\n同步工作日志')).toEqual({
            commandName: 'General',
            commandArgs: '## 任务目标\n同步工作日志',
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
