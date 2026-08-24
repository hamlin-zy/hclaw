// tests/main/llmTrace/recorder.test.ts
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, promises as fsPromises} from 'fs'
import {tmpdir} from 'os'
import path from 'path'
import {
    recordingFetch, runWithLlmTraceContext, setRecordingEnabled,
    waitForIdleWriters, clearTraceLogs, __setDepsForTest, getTraceIndexLines,
    isRecordingPaused, onTracePaused,
} from '../../../src/main/utils/llmTraceRecorder'

let dir: string
function sseResponse(chunks: string[], delayMs = 0): Response {
    const enc = new TextEncoder()
    let i = 0
    return new Response(new ReadableStream({
        async pull(c) {
            if (i < chunks.length) {
                if (delayMs) await new Promise(r => setTimeout(r, delayMs))
                c.enqueue(enc.encode(chunks[i++]))
            } else c.close()
        },
    }), {status: 200, headers: {'content-type': 'text/event-stream'}})
}

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'llm-trace-'))
    __setDepsForTest({rootDir: () => dir})
})
afterEach(() => {
    setRecordingEnabled(false)
    rmSync(dir, {recursive: true, force: true})
})

const CTX = {
    conversationId: 'conv-1', turn: 1, step: 1, attempt: 0,
    provider: 'DeepSeek 官方', model: 'deepseek-chat', apiStyle: 'chat',
    context: 'main' as const,
}

async function readIndex(): Promise<any[]> {
    return getTraceIndexLines('conv-1')
}

describe('recordingFetch', () => {
    it('开关关时直通，不产生任何文件', async () => {
        setRecordingEnabled(false)
        __setDepsForTest({upstreamFetch: async () => new Response('{}', {status: 200})})
        await recordingFetch('https://api.example.com/v1/chat/completions', {
            method: 'POST', headers: {'Authorization': 'Bearer sk-x'},
            body: '{"model":"m"}',
        })
        await waitForIdleWriters()
        expect(existsSync(path.join(dir, 'conv-1'))).toBe(false)
    })

    it('开关开：写 req.json + res.raw + index 行，headers 脱敏', async () => {
        setRecordingEnabled(true)
        __setDepsForTest({rootDir: () => dir, upstreamFetch: async () =>
            new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}})})
        const res = await runWithLlmTraceContext(CTX, () =>
            recordingFetch('https://api.example.com/v1/chat/completions', {
                method: 'POST',
                headers: {'Authorization': 'Bearer sk-secret', 'Content-Type': 'application/json'},
                body: '{"model":"deepseek-chat","messages":[]}',
            }))
        await res.text() // 模拟 SDK 消费另一分支
        await waitForIdleWriters()

        const dayDir = path.join(dir, 'conv-1', new Date().toISOString().slice(0, 10))
        const files = readdirSync(dayDir)
        expect(files.some((f: string) => f.endsWith('.req.json'))).toBe(true)
        expect(files.some((f: string) => f.endsWith('.res.raw'))).toBe(true)
        expect(files.some((f: string) => f === 'index.jsonl')).toBe(true)

        const req = JSON.parse(readFileSync(path.join(dayDir,
            files.find((f: string) => f.endsWith('.req.json'))!), 'utf8'))
        // Headers 规范化后键为小写；断言语义不变（脱敏生效）
        expect(req.headers['authorization']).toBe('***REDACTED***')
        expect(req.bodyRaw).toBe('{"model":"deepseek-chat","messages":[]}')

        const lines = await readIndex()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({status: 'ok', model: 'deepseek-chat', attempt: 0, turn: 1})
        expect(lines[0].totalMs).toBeGreaterThanOrEqual(0)
    })

    it('SSE 双路：两分支收到相同字节', async () => {
        setRecordingEnabled(true)
        const frames = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n']
        __setDepsForTest({rootDir: () => dir, upstreamFetch: async () => sseResponse(frames)})
        const res = await runWithLlmTraceContext(CTX, () =>
            recordingFetch('https://api.example.com/v1/chat/completions', {method: 'POST', body: '{}'}))
        const text = await res.text()
        await waitForIdleWriters()
        const dayDir = path.join(dir, 'conv-1', new Date().toISOString().slice(0, 10))
        const resFile = readdirSync(dayDir).find((f: string) => f.endsWith('.res.raw'))
        expect(readFileSync(path.join(dayDir, resFile!), 'utf8')).toBe(frames.join(''))
        expect(text).toBe(frames.join(''))
    })

    it('mid-stream 断开 → error + truncated=true，res.raw 保留已收部分', async () => {
        setRecordingEnabled(true)
        const frames = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n']
        __setDepsForTest({rootDir: () => dir, upstreamFetch: async () => sseResponse(frames)})
        const res = await runWithLlmTraceContext(CTX, () =>
            recordingFetch('https://api.example.com/v1/chat/completions', {method: 'POST', body: '{}'}))
        // 直接消费我们拿到的分支并中途 cancel，模拟 SDK 侧断开
        const reader = (res.body as ReadableStream<Uint8Array>).getReader()
        await reader.read()
        await reader.cancel('simulated break')
        await waitForIdleWriters()
        const lines = await readIndex()
        expect(lines[0].truncated).toBe(true)
    })

    it('流中途 SDK 侧断开（reader.cancel）→ status=error + truncated=true', async () => {
        setRecordingEnabled(true)
        const frames = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n']
        __setDepsForTest({rootDir: () => dir, upstreamFetch: async () => sseResponse(frames)})
        const res = await runWithLlmTraceContext(CTX, () =>
            recordingFetch('https://api.example.com/v1/chat/completions', {method: 'POST', body: '{}'}))
        // 中途 cancel：非用户取消的截断必须归类为 error，而非 ok+truncated
        const reader = (res.body as ReadableStream<Uint8Array>).getReader()
        await reader.read()
        await reader.cancel('simulated break')
        await waitForIdleWriters()
        const lines = await readIndex()
        expect(lines[0]).toMatchObject({status: 'error', truncated: true})
    })

    it('流中途用户取消（abortController.abort）→ status=aborted', async () => {
        setRecordingEnabled(true)
        const ac = new AbortController()
        const enc = new TextEncoder()
        // 注入带外部 AbortSignal 的上游响应流：abort 时流错误中断
        __setDepsForTest({rootDir: () => dir, upstreamFetch: async () =>
            new Response(new ReadableStream({
                start(c) {
                    c.enqueue(enc.encode('data: {"a":1}\n\n'))
                    ac.signal.addEventListener('abort', () =>
                        c.error(new Error('The user aborted a request')))
                },
            }), {status: 200, headers: {'content-type': 'text/event-stream'}})})
        const res = await runWithLlmTraceContext(CTX, () =>
            recordingFetch('https://api.example.com/v1/chat/completions', {
                method: 'POST', body: '{}', signal: ac.signal,
            }))
        const reader = (res.body as ReadableStream<Uint8Array>).getReader()
        await reader.read() // 收到首帧后用户取消
        ac.abort()
        await expect(reader.read()).rejects.toThrow()
        await waitForIdleWriters()
        const lines = await readIndex()
        // 用户主动取消优先于 truncated 归类为 aborted
        expect(lines[0]).toMatchObject({status: 'aborted', truncated: true})
    })

    it('磁盘写失败 → 触发失败暂停，后续调用直通', async () => {
        setRecordingEnabled(true)
        __setDepsForTest({
            rootDir: () => 'Z:\\nonexistent\\readonly\\path',
            upstreamFetch: async () => new Response('{}', {status: 200}),
        })
        let paused = false
        const off = onTracePaused(() => { paused = true })
        try {
            await runWithLlmTraceContext(CTX, () =>
                recordingFetch('https://api.example.com/v1/chat/completions', {method: 'POST', body: '{}'}))
            await waitForIdleWriters()
        } catch {/* 上游 fetch 可能因 mock 环境失败，不影响断言 */}
        off()
        expect(paused).toBe(true)
        expect(isRecordingPaused()).toBe(true)
    })

    it('drain 打开 res.raw 失败 → failPause + index 行仍写入(truncated)，SDK 分支不受影响', async () => {
        setRecordingEnabled(true)
        __setDepsForTest({rootDir: () => dir, upstreamFetch: async () =>
            new Response('{"ok":1}', {status: 200, headers: {'content-type': 'application/json'}})})
        // 精确触发 drain 内 fs.promises.open 失败（区别于既有用例的 req 写失败路径）
        const spy = vi.spyOn(fsPromises, 'open')
            .mockRejectedValue(new Error('simulated EACCES on res.raw'))
        let pausedReason = ''
        const off = onTracePaused(reason => { pausedReason = reason })
        try {
            const res = await runWithLlmTraceContext(CTX, () =>
                recordingFetch('https://api.example.com/v1/chat/completions', {method: 'POST', body: '{}'}))
            expect(await res.text()).toBe('{"ok":1}') // SDK 消费不受落盘失败影响
            await waitForIdleWriters() // drain 不 reject，finalize 不被跳过
        } finally {
            spy.mockRestore()
            off()
        }
        expect(pausedReason).toContain('simulated EACCES')
        expect(isRecordingPaused()).toBe(true)
        // index 行仍写入，且带 truncated 标记
        const lines = await readIndex()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({status: 'ok', truncated: true})
        expect(lines[0].reqFile).toMatch(/\.req\.json$/)
        // res.raw 未产生
        const dayDir = path.join(dir, 'conv-1', new Date().toISOString().slice(0, 10))
        expect(readdirSync(dayDir).some(f => f.endsWith('.res.raw'))).toBe(false)
    })
})
