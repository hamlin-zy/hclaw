import {describe, it, expect, vi, beforeEach} from 'vitest'
import fs from 'fs'
import path from 'path'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({execFile: execFileMock}))

import {parseEnumerateOutput, enumerateApps} from '../../../src/main/companion/appEnumerator'
import {logger} from '../../../src/main/agent/logger'

function makeLnkJson(entries: Array<Partial<{name: string; exePath: string; arguments: string; iconLocation: string; shortcutPath: string}>>): string {
    return entries.map(e => JSON.stringify(e)).join('\n')
}

beforeEach(() => {
    execFileMock.mockReset()
    vi.restoreAllMocks()
})

describe('parseEnumerateOutput（过滤规则）', () => {
    beforeEach(() => {
        vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => !String(p).includes('missing'))
    })
    it('正常解析', () => {
        const out = makeLnkJson([
            {name: 'Obsidian', exePath: 'C:\\apps\\Obsidian.exe', arguments: '', shortcutPath: 'C:\\lnks\\Obsidian.lnk'},
        ])
        expect(parseEnumerateOutput(out)).toEqual([{
            name: 'Obsidian', exePath: 'C:\\apps\\Obsidian.exe', args: '', shortcutPath: 'C:\\lnks\\Obsidian.lnk',
        }])
    })
    it('【Review Focus 2】单条结果：单行单对象输出，仍解析出 1 条', () => {
        const out = JSON.stringify({name: 'Only', exePath: 'C:\\apps\\Only.exe', arguments: '', shortcutPath: 'C:\\lnks\\Only.lnk'})
        const result = parseEnumerateOutput(out)
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe('Only')
    })
    it('exePath 为空被过滤', () => {
        const out = makeLnkJson([{name: 'Bad', exePath: '', arguments: '', shortcutPath: 'C:\\l.lnk'}])
        expect(parseEnumerateOutput(out)).toEqual([])
    })
    it('exePath 不存在被过滤', () => {
        const out = makeLnkJson([{name: 'Missing', exePath: 'C:\\missing\\x.exe', arguments: '', shortcutPath: ''}])
        expect(parseEnumerateOutput(out)).toEqual([])
    })
    it('exePath 指向 System32 被过滤', () => {
        const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
        const out = makeLnkJson([{name: 'Uninstall', exePath: path.join(sysRoot, 'System32', 'uninstall.exe'), arguments: '', shortcutPath: ''}])
        expect(parseEnumerateOutput(out)).toEqual([])
    })
    it('System32 前缀误伤修复：System32Foo 不被过滤，System32 本身被过滤', () => {
        const sysRoot = (process.env.SystemRoot ?? 'C:\\Windows')
        const sys32 = path.join(sysRoot, 'System32')
        const existsSpy = vi.spyOn(fs, 'existsSync')
        existsSpy.mockImplementation((p: fs.PathLike) => {
            // 只对 System32 子路径返回 false；System32 目录本身与 System32Foo 均返回 true，
            // 确保 'Exact' 被过滤只能来自等值排除分支（而非 existsSync=false 的假象）
            const s = String(p).toLowerCase()
            return !s.startsWith(sys32.toLowerCase() + path.sep)
        })
        const out = makeLnkJson([
            {name: 'Foo', exePath: `${sysRoot}\\System32Foo\\x.exe`, arguments: '', shortcutPath: ''},
            {name: 'Exact', exePath: sys32, arguments: '', shortcutPath: ''},
        ])
        const result = parseEnumerateOutput(out)
        expect(result.map(r => r.name)).toEqual(['Foo'])
    })
    it('exePath 指向 .lnk 自身（循环引用）被过滤', () => {
        const out = makeLnkJson([{name: 'Loop', exePath: 'C:\\lnks\\Loop.lnk', arguments: '', shortcutPath: 'C:\\lnks\\Loop.lnk'}])
        expect(parseEnumerateOutput(out)).toEqual([])
    })
    it('单行坏 JSON 跳过该行，其余行保留（不炸整批）', () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        const good = JSON.stringify({name: 'Good', exePath: 'C:\\apps\\g.exe', arguments: '', shortcutPath: ''})
        const out = `${good}\nnot json at all\n${good.replace('Good', 'Good2').replace('g.exe', 'g2.exe')}`
        const result = parseEnumerateOutput(out)
        expect(result.map(r => r.name)).toEqual(['Good', 'Good2'])
        expect(warnSpy).toHaveBeenCalledWith('companion-enumerate-parse-failed', expect.objectContaining({error: expect.any(String)}))
    })
    it('整段非 JSON 输出（单行坏数据）跳过后返回空数组', () => {
        expect(parseEnumerateOutput('not json at all')).toEqual([])
    })
    it('空输出返回空数组', () => {
        expect(parseEnumerateOutput('')).toEqual([])
    })
})

describe('enumerateApps', () => {
    it('非 win32 返回空数组且不 spawn PowerShell', async () => {
        const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
        await expect(enumerateApps()).resolves.toEqual([])
        expect(execFileMock).not.toHaveBeenCalled()
        platformSpy.mockRestore()
    })
    it('调用 powershell.exe 带 -NoProfile 与 15s 超时', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
        vi.spyOn(fs, 'existsSync').mockReturnValue(true)
        execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: {stdout: string}) => void) =>
            cb(null, {stdout: JSON.stringify({name: 'A', exePath: 'C:\\apps\\a.exe', arguments: '', shortcutPath: ''})}))
        await enumerateApps()
        expect(execFileMock).toHaveBeenCalledWith(
            'powershell.exe', ['-NoProfile', '-Command', expect.stringContaining('WScript.Shell')],
            expect.objectContaining({timeout: 15000}), expect.any(Function))
    })
    it('【部分结果容错】超时（error 带 stdout，多行部分结果）返回已收集结果', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
        vi.spyOn(fs, 'existsSync').mockReturnValue(true)
        const partial = [
            JSON.stringify({name: 'Partial1', exePath: 'C:\\apps\\p1.exe', arguments: '', shortcutPath: ''}),
            JSON.stringify({name: 'Partial2', exePath: 'C:\\apps\\p2.exe', arguments: '', shortcutPath: ''}),
        ].join('\n')
        const err: NodeJS.ErrnoException & {stdout?: string} = Object.assign(new Error('timeout'), {stdout: partial})
        execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => cb(err))
        const result = await enumerateApps()
        expect(result.map(r => r.name)).toEqual(['Partial1', 'Partial2'])
    })
    it('完全失败（无 stdout）返回空数组不抛异常', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
        execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
            cb(new Error('powershell missing')))
        await expect(enumerateApps()).resolves.toEqual([])
    })
})
