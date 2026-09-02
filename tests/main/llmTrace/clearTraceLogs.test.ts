// tests/main/llmTrace/clearTraceLogs.test.ts
// clearTraceLogs 重试逻辑：Windows 下 Worker 在途写/杀软占用导致 rmdir EBUSY/EPERM，
// 修复为对可重试错误码做有界指数退避重试（最多 6 次尝试）。
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync} from 'fs'
import {tmpdir} from 'os'
import path from 'path'
import {clearTraceLogs, setRecordingEnabled, __setDepsForTest} from '../../../src/main/utils/llmTraceRecorder'
import {promises as fsPromises} from 'fs'

let dir: string

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'llm-trace-clear-'))
    __setDepsForTest({rootDir: () => dir})
})
afterEach(() => {
    setRecordingEnabled(false)
    vi.restoreAllMocks()
    rmSync(dir, {recursive: true, force: true})
})

/** 造一个与生产结构一致的日志目录：<root>/<conv>/<day>/index.jsonl */
function seedTraceDir(): string {
    const dayDir = path.join(dir, 'conv-1', '2026-09-01')
    mkdirSync(dayDir, {recursive: true})
    writeFileSync(path.join(dayDir, 'index.jsonl'), '{"id":"x"}\n', 'utf8')
    return dayDir
}

function errnoError(code: string): NodeJS.ErrnoException {
    const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException
    e.code = code
    return e
}

describe('clearTraceLogs', () => {
    it('目录存在：一次 rm 成功即删除整个根目录', async () => {
        seedTraceDir()
        await clearTraceLogs()
        expect(existsSync(dir)).toBe(false)
    })

    it('目录不存在：静默成功，不抛错', async () => {
        await expect(clearTraceLogs()).resolves.toBeUndefined()
    })

    it('首次 EBUSY、二次成功：重试后删除成功', async () => {
        seedTraceDir()
        const spy = vi.spyOn(fsPromises, 'rm')
            .mockRejectedValueOnce(errnoError('EBUSY'))
            .mockImplementation((async (p: string) => {
                rmSync(p, {recursive: true, force: true})
            }) as never)
        await expect(clearTraceLogs()).resolves.toBeUndefined()
        expect(spy).toHaveBeenCalledTimes(2)
        expect(existsSync(dir)).toBe(false)
    })

    it('首次 EPERM、二次成功：EPERM 同样重试', async () => {
        seedTraceDir()
        const spy = vi.spyOn(fsPromises, 'rm')
            .mockRejectedValueOnce(errnoError('EPERM'))
            .mockResolvedValue(undefined as never)
        await expect(clearTraceLogs()).resolves.toBeUndefined()
        expect(spy).toHaveBeenCalledTimes(2)
    })

    it('持续 EBUSY：抛出最后一次错误，且总尝试次数有界（6 次）', async () => {
        seedTraceDir()
        const spy = vi.spyOn(fsPromises, 'rm').mockRejectedValue(errnoError('EBUSY'))
        await expect(clearTraceLogs()).rejects.toMatchObject({code: 'EBUSY'})
        expect(spy).toHaveBeenCalledTimes(6)
    })

    it('不可重试错误码：立即抛出，不做无谓重试', async () => {
        seedTraceDir()
        const spy = vi.spyOn(fsPromises, 'rm').mockRejectedValue(errnoError('EFOO'))
        await expect(clearTraceLogs()).rejects.toMatchObject({code: 'EFOO'})
        expect(spy).toHaveBeenCalledTimes(1)
    })

    it('真实 fs 场景：混合目录（多 conv/多 day/杂项文件）整体清除', async () => {
        seedTraceDir()
        // 再建 conv-2 深层文件 + 根级杂项
        const d2 = path.join(dir, 'conv-2', '2026-08-31')
        mkdirSync(d2, {recursive: true})
        writeFileSync(path.join(d2, 'a.req.json'), '{}', 'utf8')
        writeFileSync(path.join(dir, 'stray.txt'), 'x', 'utf8')
        await clearTraceLogs()
        expect(existsSync(dir)).toBe(false)
    })
})
