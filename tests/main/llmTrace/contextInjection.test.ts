// tests/main/llmTrace/contextInjection.test.ts
// 固化 ALS 上下文注入行为基线：
// 1) 并发 runWithLlmTraceContext 作用域互不串线（归因按各自 ctx.conversationId 落目录）；
// 2) withLlmTraceStream：惰性 async generator 在 ALS 作用域之外消费时，归因仍来自 traceCtx。
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, rmSync, readdirSync} from 'fs'
import {tmpdir} from 'os'
import path from 'path'
import {
    recordingFetch, runWithLlmTraceContext, withLlmTraceStream,
    setRecordingEnabled, waitForIdleWriters, getTraceIndexLines, __setDepsForTest,
} from '../../../src/main/utils/llmTraceRecorder'

let root = ''

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ctx-'))
    __setDepsForTest({
        rootDir: () => root,
        upstreamFetch: async () => new Response('{}', {status: 200}),
    })
})

afterEach(() => {
    setRecordingEnabled(false)
    rmSync(root, {recursive: true, force: true})
})

describe('ALS 上下文注入', () => {
    it('并发交错时上下文不串线（各会话产物落在各自会话目录）', async () => {
        setRecordingEnabled(true)
        const baseCtx = {
            turn: 1, step: 1, attempt: 0,
            provider: 'p', model: 'm', apiStyle: 'chat',
            context: 'main' as const,
        }

        // 两个作用域写同一 root：产物目录由 ctx.conversationId 决定，
        // 断言 A/B 各自落位且无 unknown 回退 → 无串线、无作用域丢失
        await Promise.all([
            runWithLlmTraceContext({...baseCtx, conversationId: 'A'}, async () => {
                await recordingFetch('https://x.dev/c', {method: 'POST', body: '{}'})
            }),
            runWithLlmTraceContext({...baseCtx, conversationId: 'B'}, async () => {
                await recordingFetch('https://x.dev/c', {method: 'POST', body: '{}'})
            }),
        ])
        await waitForIdleWriters()

        // 会话子目录归属正确：A 目录下是 A，不是 B
        const entries = readdirSync(root)
        expect(entries).toContain('A')
        expect(entries).toContain('B')
        expect(entries).not.toContain('unknown')
    })

    it('无 ALS 上下文时回退 unknown 会话目录', async () => {
        setRecordingEnabled(true)
        await recordingFetch('https://x.dev/c', {method: 'POST', body: '{}'})
        await waitForIdleWriters()
        expect(readdirSync(root)).toContain('unknown')
    })
})

describe('withLlmTraceStream（流消费时刻归因）', () => {
    it('惰性生成器在作用域外首次消费时，record 归因来自 traceCtx 而非 unknown', async () => {
        setRecordingEnabled(true)

        const traceCtx = {
            conversationId: 'stream-conv',
            turn: 5, step: 2, attempt: 3,
            provider: 'prov', model: 'mdl', apiStyle: 'chat',
            context: 'main' as const,
        }

        // 模拟 adapter.chat 的 async *chat：生成器体惰性执行，
        // 首次 next() 时才发起 HTTP（recordingFetch）
        let entered = false
        async function* lazyChat(): AsyncGenerator<string> {
            entered = true
            await recordingFetch('https://x.dev/chat/completions', {method: 'POST', body: '{}'})
            yield 'chunk'
        }
        const rawStream = lazyChat()

        // 创建时不进入任何 ALS 作用域；确认生成器体确实未提前执行
        expect(entered).toBe(false)

        // 消费发生在「创建时刻之后」（等价于原实现中 ALS 作用域已退出）
        await Promise.resolve()
        let chunks = 0
        for await (const chunk of withLlmTraceStream(traceCtx, rawStream)) {
            expect(chunk).toBe('chunk')
            chunks++
        }
        expect(entered).toBe(true)
        expect(chunks).toBe(1)

        await waitForIdleWriters()

        // 断言 index 行归因字段全部来自 traceCtx（而非 FALLBACK_CTX 的 unknown/0）
        const records = await getTraceIndexLines('stream-conv')
        expect(records.length).toBe(1)
        const r = records[0]!
        expect(r.conversationId).toBe('stream-conv')
        expect(r.turn).toBe(5)
        expect(r.step).toBe(2)
        expect(r.attempt).toBe(3)
        expect(r.provider).toBe('prov')
        expect(r.model).toBe('mdl')
        expect(r.context).toBe('main')
        expect(r.status).toBe('ok')

        // 会话目录确实建立在该 root 下（而非 unknown 目录）
        expect(readdirSync(root)).toContain('stream-conv')
    })

    it('底层流的 return()/throw() 透传语义保持', async () => {
        setRecordingEnabled(false) // 本用例只验证协议透传，不涉及录制

        // ── return()：正常收尾 ──
        async function* finite(): AsyncGenerator<number> {
            yield 1
            yield 2
            yield 3
        }
        const s1 = withLlmTraceStream(
            {conversationId: 'ret', turn: 0, step: 0, attempt: 0,
                provider: 'p', model: 'm', apiStyle: 'chat', context: 'background'},
            finite(),
        )
        expect(await s1.next()).toEqual({value: 1, done: false})
        const ret = await s1.return(99)
        expect(ret).toEqual({value: 99, done: true})

        // ── throw()：错误原样从生成器体内抛出 ──
        async function* throwing(): AsyncGenerator<number> {
            yield 1
            throw new Error('boom')
        }
        const s2 = withLlmTraceStream(
            {conversationId: 'thr', turn: 0, step: 0, attempt: 0,
                provider: 'p', model: 'm', apiStyle: 'chat', context: 'background'},
            throwing(),
        )
        await s2.next()
        await expect(s2.throw(new Error('injected'))).rejects.toThrow('injected')
    })
})
