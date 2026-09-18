/**
 * will-quit 退出契约（内存泄漏 B 批 Task 1 / S1a）
 *
 * 静态断言（readSrc 手法，先例 tests/main/scheduler/silentFailureContract.test.ts）：
 * 退出流程必须**主动**关闭 scheduler worker，而不是依赖「进程退出会把它带走」——
 * 后者的语义是「worker 线程连同它持有的定时器/子进程句柄一起被资源回收阶段处理」，
 * 退出窗口内 cron 仍可能触发一次任务，且清理时机不受控（本批要堵的泄漏面之一）。
 *
 * 断言的是**顺序**而非仅存在：scheduler 的关闭必须排在 agentManager.abortAll() 与
 * 数据库 flush 之前，否则 abort 阶段新起的脚本任务会落在已经收尾的调度器上。
 */
import {describe, expect, it} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const INDEX_SRC = 'src/main/index.ts'
const readSrc = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')

/** 截取 `app.on('will-quit', ...)` 回调体（大括号配平；该回调体内无不成对的大括号字面量） */
function willQuitBlock(src: string): string {
    const anchor = src.indexOf("app.on('will-quit'")
    expect(anchor, "src/main/index.ts 应保留 app.on('will-quit') 处理器").toBeGreaterThanOrEqual(0)
    const open = src.indexOf('{', anchor)
    let depth = 0
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') {
            depth--
            if (depth === 0) return src.slice(open + 1, i)
        }
    }
    throw new Error('will-quit 回调体未能配平')
}

describe('内存泄漏 B 批 Task 1 — will-quit 主动关闭 scheduler worker', () => {
    it('回调体内调用 schedulerManager.shutdown()', () => {
        expect(willQuitBlock(readSrc(INDEX_SRC))).toContain('schedulerManager.shutdown()')
    })

    it('关闭排在 agentManager.abortAll() 与数据库 flush 之前', () => {
        const block = willQuitBlock(readSrc(INDEX_SRC))
        const shutdown = block.indexOf('schedulerManager.shutdown()')
        const abortAll = block.indexOf('agentManager.abortAll()')
        const flush = block.indexOf('flushDatabase()')

        expect(abortAll, 'will-quit 应仍保留 agentManager.abortAll()').toBeGreaterThanOrEqual(0)
        expect(flush, 'will-quit 应仍保留 flushDatabase() 收尾步骤').toBeGreaterThanOrEqual(0)
        expect(shutdown).toBeLessThan(abortAll)
        expect(shutdown).toBeLessThan(flush)
    })

    it('不再保留「scheduler worker 交给进程退出处理」的旧注释（它已不成立）', () => {
        expect(willQuitBlock(readSrc(INDEX_SRC)))
            .not.toMatch(/Scheduler worker will be terminated by process exit/)
    })
})
