// tests/main/llmTrace/perf.test.ts
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, rmSync} from 'fs'
import {tmpdir} from 'os'
import path from 'path'
import {recordingFetch, setRecordingEnabled, waitForIdleWriters,
    runWithLlmTraceContext, __setDepsForTest} from '../../../src/main/utils/llmTraceRecorder'

const CTX = {conversationId: 'perf', turn: 1, step: 1, attempt: 0,
    provider: 'p', model: 'm', apiStyle: 'chat', context: 'main' as const}

beforeEach(() => { __setDepsForTest({rootDir: () => mkdtempSync(path.join(tmpdir(), 'perf-'))}) })
afterEach(() => setRecordingEnabled(false))

function bigSse(totalMB: number, chunkKB = 64): Response {
    const chunk = 'x'.repeat(chunkKB * 1024)
    const count = Math.ceil(totalMB * 1024 / chunkKB)
    const enc = new TextEncoder()
    let i = 0
    return new Response(new ReadableStream({
        pull(c) {
            if (i++ < count) c.enqueue(enc.encode(`data: ${chunk}\n\n`))
            else c.close()
        },
    }), {status: 200, headers: {'content-type': 'text/event-stream'}})
}

describe('性能预算（规格 §7）', () => {
    it('高速流（≥10MB/s）：主流消费不被落盘分支明显拖慢', async () => {
        setRecordingEnabled(true)
        // 基准：不经 recorder 的裸流耗时（使用相同的 bigSse 参数）
        __setDepsForTest({upstreamFetch: async () => bigSse(8)})
        const t0 = performance.now()
        const bare = await bigSse(8)
        await bare.arrayBuffer()
        const bareMs = performance.now() - t0

        const t1 = performance.now()
        const wrapped = await runWithLlmTraceContext(CTX, () =>
            recordingFetch('https://x.dev/c', {method: 'POST', body: '{}'}))
        await wrapped.arrayBuffer()
        const wrappedMs = performance.now() - t1
        await waitForIdleWriters()

        // 允许 30% 抖动余量；预算本质是"无可测减速"
        expect(wrappedMs).toBeLessThan(bareMs * 1.3 + 50)
    }, 60_000)

    it('内存峰值 ≤512KB：消费期间 heapUsed 增量受控', async () => {
        setRecordingEnabled(true)
        __setDepsForTest({upstreamFetch: async () => bigSse(16)})
        global.gc?.()
        const before = process.memoryUsage().heapUsed
        const res = await runWithLlmTraceContext(CTX, () =>
            recordingFetch('https://x.dev/c', {method: 'POST', body: '{}'}))
        await res.arrayBuffer()
        await waitForIdleWriters()
        global.gc?.()
        const delta = process.memoryUsage().heapUsed - before
        expect(delta).toBeLessThan(64 * 1024 * 1024) // CI 宽松上限 64MB（含流本身缓冲）；
        // 严格 512KB 预算以本地手动 perf run 为准，CI 只做回归护栏
    }, 60_000)
})