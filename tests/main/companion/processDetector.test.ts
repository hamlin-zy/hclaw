import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({execFile: execFileMock}))

import {parseTaskList, isProcessRunning, resetProcessCache} from '../../../src/main/companion/processDetector'

const TASKLIST_OUTPUT = [
    '"chrome.exe","1234","Console","1","50,000 K"',
    '"Obsidian.exe","5678","Console","1","120,000 K"',
    '"explorer.exe","9","Console","1","30,000 K"',
].join('\r\n')

beforeEach(() => {
    resetProcessCache()
    execFileMock.mockReset()
})
afterEach(() => resetProcessCache())

describe('parseTaskList', () => {
    it('正常 CSV 输出解析为小写进程名', () => {
        expect(parseTaskList(TASKLIST_OUTPUT)).toEqual(['chrome.exe', 'obsidian.exe', 'explorer.exe'])
    })
    it('空输出返回空数组', () => {
        expect(parseTaskList('')).toEqual([])
    })
    it('malformed 行被跳过（无引号前缀）', () => {
        expect(parseTaskList('broken line\n"OK.exe","1","Console","1","1 K"')).toEqual(['ok.exe'])
    })
})

describe('非 win32 早退（task-e9b47ac7）', () => {
    const realPlatform = process.platform
    afterEach(() => {
        Object.defineProperty(process, 'platform', {value: realPlatform})
    })

    it('非 win32：直接返回 false，不执行 tasklist', async () => {
        Object.defineProperty(process, 'platform', {value: 'linux', configurable: true})
        execFileMock.mockImplementation(() => { throw new Error('should not be called') })
        await expect(isProcessRunning('obsidian.exe')).resolves.toBe(false)
        expect(execFileMock).not.toHaveBeenCalled()
    })
})

describe('isProcessRunning', () => {
    it('命中（大小写不敏感）', async () => {
        execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: {stdout: string}) => void) =>
            cb(null, {stdout: TASKLIST_OUTPUT}))
        await expect(isProcessRunning('OBSIDIAN.EXE')).resolves.toBe(true)
    })
    it('未命中', async () => {
        execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: {stdout: string}) => void) =>
            cb(null, {stdout: TASKLIST_OUTPUT}))
        await expect(isProcessRunning('notepad.exe')).resolves.toBe(false)
    })
    it('tasklist 执行失败按「未运行」处理（不抛异常）', async () => {
        execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
            cb(new Error('killed by timeout')))
        await expect(isProcessRunning('obsidian.exe')).resolves.toBe(false)
    })
    it('【缓存契约】同 500ms 周期内多次调用只 spawn 一次 tasklist', async () => {
        execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: {stdout: string}) => void) =>
            cb(null, {stdout: TASKLIST_OUTPUT}))
        await isProcessRunning('obsidian.exe')
        await isProcessRunning('chrome.exe')
        await isProcessRunning('notepad.exe')
        expect(execFileMock).toHaveBeenCalledTimes(1)
        expect(execFileMock).toHaveBeenCalledWith('tasklist', ['/FO', 'CSV', '/NH'], expect.objectContaining({timeout: 5000}), expect.any(Function))
    })
})
