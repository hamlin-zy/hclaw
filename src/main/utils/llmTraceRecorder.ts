// src/main/utils/llmTraceRecorder.ts
/**
 * LLM 调用轨迹录制器 —— HTTP 层 fetch 包装（常驻注入 SDK client）
 * 规格：docs/superpowers/specs/2026-08-24-llm-trace-log-design.md §4
 *
 * 线程模型：per-thread 模块单例（主线程与每个 Agent Worker 各一份），
 * 开关状态由宿主线程序广播（见 setRecordingEnabled 的跨线程说明）。
 */
import {randomUUID} from 'crypto'
import fs from 'fs'
import type {FileHandle} from 'fs/promises'
import os from 'os'
import path from 'path'
import {AsyncLocalStorage} from 'async_hooks'
// Node 原生模块，Worker 线程与主线程均可顶层 import（区别于 electron：需防御式 require）
import {parentPort, workerData} from 'worker_threads'
import type {LlmCallRecord, LlmTraceContextKind} from '@shared/types/llmTrace'
import {sanitizeHeaders} from '@shared/types/llmTrace'

export interface LlmTraceCallContext {
    conversationId: string
    turn: number
    step: number
    attempt: number
    provider: string
    model: string
    apiStyle: string
    context: LlmTraceContextKind
}

interface LlmTraceDeps {
    rootDir(): string
    upstreamFetch?: typeof globalThis.fetch
}

/**
 * 默认根目录（惰性缓存）：主 agent loop 跑在 worker_threads Worker 内，
 * Electron 对 Worker 内 electron 模块的暴露面有限——require('electron') 可能失败
 * 或缺 app 字段。因此 try/catch 防御并缓存结果，保证本函数绝不同步抛出。
 *
 * 解析优先级（保证 Worker 写盘与主线程读盘落在同一位置）：
 *   1. workerData.params.llmTraceRootDir —— 主进程 spawn Worker 时下发主进程解析结果
 *      （Worker 内 electron 不可用，若自行回退 ~/.hclaw 会导致读写分叉）
 *   2. electron userData
 *   3. HCLAW_USER_DATA
 *   4. ~/.hclaw/logs/llm-calls
 */
let cachedDefaultRootDir: string | null = null
function defaultRootDir(): string {
    if (cachedDefaultRootDir) return cachedDefaultRootDir
    // 1. Worker 线程：优先复用主进程下发的 rootDir（见 manager.impl.ts spawn 接线）；
    //    主线程/测试环境 workerData 为 undefined，自然跳过。
    const fromWorkerData = (workerData as {params?: {llmTraceRootDir?: string}} | undefined)?.params?.llmTraceRootDir
    if (fromWorkerData) {
        cachedDefaultRootDir = fromWorkerData
        return cachedDefaultRootDir
    }
    // 2-4. electron userData → env → 用户主目录回退
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Worker 内 electron 暴露面有限，需防御式 require
        const {app} = require('electron')
        cachedDefaultRootDir = path.join(app.getPath('userData'), 'logs', 'llm-calls')
    } catch {
        cachedDefaultRootDir = process.env.HCLAW_USER_DATA
            ?? path.join(os.homedir(), '.hclaw', 'logs', 'llm-calls')
    }
    return cachedDefaultRootDir
}

/** 统一根目录解析：主线程读盘（llmCallLogStore）与 Worker 写盘共用同一来源 */
export function getLlmTraceRootDir(): string {
    return defaultRootDir()
}

let deps: LlmTraceDeps = {
    rootDir: defaultRootDir,
}
export function __setDepsForTest(patch: Partial<LlmTraceDeps>): void {
    deps = {...deps, ...patch}
}

// ── 运行时开关（纯内存态，不持久化）──
let enabled = false
let paused = false
const pauseListeners = new Set<(reason: string) => void>()

export function isRecordingEnabled(): boolean { return enabled && !paused }
export function isRecordingPaused(): boolean { return paused }
export function onTracePaused(cb: (reason: string) => void): () => void {
    pauseListeners.add(cb)
    return () => pauseListeners.delete(cb)
}

/** 主线程 UI 调用；Worker 线程由消息监听器调用（Task 5 接线） */
export function setRecordingEnabled(v: boolean): void {
    enabled = v
    if (!v) paused = false
}

// ── ALS 上下文 ──
const als = new AsyncLocalStorage<LlmTraceCallContext>()
export function runWithLlmTraceContext<T>(ctx: LlmTraceCallContext, fn: () => Promise<T>): Promise<T> {
    return als.run(ctx, fn)
}

/**
 * 流包装：让 ALS 上下文在「流消费时刻」依然可用。
 *
 * adapter.chat 是 async *chat 异步生成器，生成器体（含发起 HTTP 的 SDK 调用）
 * 惰性执行——首次 next() 时才运行；而 for await 消费通常发生在
 * runWithLlmTraceContext(...) 返回之后（ALS 作用域已退出）。
 * 此处代理 next()/return()/throw()，每次协议调用重新置入 ctx，
 * 保证 recordingFetch 无论何时被触发都能读到正确归因。
 */
export function withLlmTraceStream<T>(
    ctx: LlmTraceCallContext,
    stream: AsyncGenerator<T>,
): AsyncGenerator<T> {
    return {
        [Symbol.asyncIterator]() { return this },
        next(...args: Parameters<AsyncGenerator<T>['next']>) {
            return als.run(ctx, () => stream.next(...args))
        },
        return(value: Awaited<ReturnType<AsyncGenerator<T>['return']>>): Promise<Awaited<ReturnType<AsyncGenerator<T>['return']>>> {
            return als.run(ctx, () => stream.return(value))
        },
        throw(e: unknown) {
            return als.run(ctx, () => stream.throw(e))
        },
        async [Symbol.asyncDispose]() {
            // for await...of 提前退出（break/return）时触发；委托底层生成器执行 finally 收尾
            await stream.return(undefined as never)
        },
    }
}
const FALLBACK_CTX: LlmTraceCallContext = {
    conversationId: 'unknown', turn: 0, step: 0, attempt: 0,
    provider: 'unknown', model: 'unknown', apiStyle: 'unknown', context: 'unknown',
}

// ── 在途写入登记（flush barrier）──
const activeWrites = new Set<Promise<void>>()
function track<T>(p: Promise<T>): Promise<T> {
    const w = p.catch(() => {}).then(() => { activeWrites.delete(w as Promise<void>) })
    activeWrites.add(w as Promise<void>)
    return p
}
export async function waitForIdleWriters(): Promise<void> {
    while (activeWrites.size > 0) await Promise.allSettled([...activeWrites])
}

/** 是否 worker_threads 工作线程（主线程 parentPort 为 null） */
function isWorkerThread(): boolean {
    return parentPort != null
}

/** Worker 线程经 parentPort 转发消息给主进程；失败静默（不影响录制主流程） */
function postToParent(msg: unknown): void {
    if (!isWorkerThread()) return
    try { parentPort?.postMessage(msg) } catch { /* ignore */ }
}

function failPause(reason: string): void {
    paused = true
    for (const cb of pauseListeners) { try { cb(reason) } catch { /* ignore */ } }
    // Worker 线程：暂停提示经 parentPort 转发主进程（主线程自身场景由 onTracePaused 监听器处理）
    postToParent({type: 'llm-trace-paused', reason})
}

function handleFsError(err: unknown, phase: string): void {
    console.warn(`[llm-trace] ${phase} 写入失败，暂停录制`, err)
    failPause(String(err))
}

function dayDirOf(root: string, ctx: LlmTraceCallContext, ts: number): string {
    // conversationId 清洗：仅保留安全字符，其余映射为 _
    const safeId = ctx.conversationId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
    const day = new Date(ts).toISOString().slice(0, 10)
    return path.join(root, safeId, day)
}

export const recordingFetch: typeof globalThis.fetch = async (input, init) => {
    if (!isRecordingEnabled()) return (deps.upstreamFetch ?? globalThis.fetch)(input, init)

    const ctx = als.getStore() ?? FALLBACK_CTX
    const ts = Date.now()
    const id = randomUUID()
    const dir = dayDirOf(deps.rootDir(), ctx, ts)

    // ── 步骤1：req 最先固化（发送前）──
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rawHeaders: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { rawHeaders[k] = v })
    const bodyRaw = typeof init?.body === 'string'
        ? init.body
        : init?.body != null ? `[unserializable body: ${init.body.constructor?.name}]` : ''
    const reqFile = `${id}.req.json`
    const record: LlmCallRecord = {
        id, ts,
        conversationId: ctx.conversationId, turn: ctx.turn, step: ctx.step, attempt: ctx.attempt,
        context: ctx.context, provider: ctx.provider, model: ctx.model, apiStyle: ctx.apiStyle,
        status: 'ok', firstByteMs: 0, totalMs: 0,
        reqFile,
    }

    // res/index 落盘前必须等目录就绪（上游快速返回时 mkdir 可能尚未完成）
    const dirReady = fs.promises.mkdir(dir, {recursive: true})
    // M-1 写序屏障：req 写入 promise 需在 finalize 写 index 前完成，维持 req→res→index 不变量
    const whenReqWritten = track(dirReady
        .then(() => fs.promises.writeFile(path.join(dir, reqFile),
            JSON.stringify({url, headers: sanitizeHeaders(rawHeaders), bodyRaw}), 'utf8'))
        .catch(err => handleFsError(err, 'req')))

    // ── 步骤2-3：发起请求 + tee 双路 ──
    const start = ts
    let firstByteMs = 0
    let response: Response
    // 中止判定必须在判定时刻实时读取：流消费中途才 abort 时，tee 后的同步快照是过期值。
    // aborted 仅指用户主动取消（signal 已 abort）；网络中断/服务端断开=error（+truncated）。
    const isAborted = (): boolean =>
        !!(init?.signal as AbortSignal | undefined)?.aborted
        || (input instanceof Request && input.signal.aborted)
    try {
        response = await (deps.upstreamFetch ?? globalThis.fetch)(input, init)
        firstByteMs = Date.now() - start
    } catch (err) {
        // 连接未建立：无 resFile
        record.status = isAborted() ? 'aborted' : 'error'
        record.firstByteMs = Date.now() - start
        record.totalMs = record.firstByteMs
        record.error = {message: err instanceof Error ? err.message : String(err)}
        await whenReqWritten
        await track(writeIndexLine(dir, record))
        notifyWindow(record)
        throw err
    }

    record.firstByteMs = firstByteMs
    record.resEncoding = response.headers.get('content-encoding') ?? undefined

    if (!response.body) { // 204 等 null-body 响应
        record.status = response.ok ? 'ok' : 'error'
        record.totalMs = Date.now() - start
        await whenReqWritten
        await track(writeIndexLine(dir, record))
        notifyWindow(record)
        return response
    }

    await whenReqWritten
    const [sdkBranch, traceBranch] = response.body.tee()
    const resFile = `${id}.res.raw`
    record.resFile = resFile

    // 落盘分支：独立异步排空循环，持续消费防 tee 积压（背压约束）
    // 不变量：drain 永不 reject——open/close 等磁盘失败走 handleFsError+failPause，
    // 流中断置 truncated；finalize 始终执行，index 行始终写入。
    let truncated = false
    let streamBroken = false // 流读取/消费中断（网络中断、SDK 侧断开），区别于磁盘写失败截断
    const drain = track((async () => {
        let fh: FileHandle | null = null
        const reader = traceBranch.getReader()
        const decoder = new TextDecoder()
        let buffered = 0
        let pending = ''
        const flush = async (): Promise<boolean> => {
            if (buffered === 0 && pending.length === 0) return true
            try {
                await fh!.write(pending)
            } catch (err) {
                handleFsError(err, 'res')
                truncated = true
                return false
            }
            pending = ''
            buffered = 0
            return true
        }
        try {
            try {
                fh = await fs.promises.open(path.join(dir, resFile), 'w')
            } catch (err) {
                handleFsError(err, 'res')
                truncated = true
                await reader.cancel(err) // 释放 tee 分支，避免 SDK 侧积压
                return
            }
            for (;;) {
                const {done, value} = await reader.read()
                if (done) break
                pending += decoder.decode(value, {stream: true})
                buffered += value.byteLength
                if (buffered >= 256 * 1024 && !(await flush())) {
                    await reader.cancel(new Error('res write failed'))
                    return
                }
            }
            pending += decoder.decode()
            if (!(await flush())) {
                await reader.cancel(new Error('res write failed'))
                return
            }
        } catch {
            truncated = true // 流读取/解码中断，非磁盘错误
            streamBroken = true
        } finally {
            if (fh) {
                try {
                    await fh.close()
                } catch (err) {
                    handleFsError(err, 'res')
                    truncated = true
                }
            }
        }
    })())

    // 包装返回给 SDK 的分支：结束时补写 index 行
    const wrappedBody = new ReadableStream<Uint8Array>({
        async start(controller) {
            const reader = sdkBranch.getReader()
            try {
                for (;;) {
                    const {done, value} = await reader.read()
                    if (done) break
                    controller.enqueue(value)
                }
                controller.close()
            } catch (err) {
                truncated = true
                streamBroken = true // SDK 分支消费中断（cancel/背压断开）
                controller.error(err)
            }
        },
    }).pipeThrough(new TransformStream<Uint8Array, Uint8Array>())

    // finalize 纳入 track：保证 waitForIdleWriters 返回时 index 行已持久化（req→res→index 不变量）
    void track(drain.then(async () => {
        record.truncated = truncated || undefined
        // 中止判定实时重读 signal：tee 后同步快照在「流消费中途 abort」场景下是过期值
        const aborted = isAborted()
        if (aborted) {
            record.status = 'aborted'
        } else if (streamBroken && response.ok) {
            // 流未走完且非用户取消：网络中断/服务端断开 → error 而非 ok+truncated
            // （磁盘写失败截断不在此列——流本身完整，仅落盘不全）
            record.status = 'error'
            record.error = {message: 'stream truncated before completion'}
        } else {
            record.status = response.ok ? 'ok' : 'error'
        }
        if (!response.ok && !aborted && !record.error) {
            try {
                const errText = await fs.promises.readFile(path.join(dir, resFile!), 'utf8')
                record.error = {message: truncateStr(errText, 500)}
            } catch { /* ignore */ }
        }
        record.totalMs = Date.now() - start
        await whenReqWritten.catch(() => {}) // M-1 写序屏障：index 行必须晚于 req 行持久化
        await writeIndexLine(dir, record)
        notifyWindow(record)
    }))

    return new Response(wrappedBody, {
        status: response.status, statusText: response.statusText, headers: response.headers,
    })
}

function truncateStr(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) + '…' }

async function writeIndexLine(dir: string, r: LlmCallRecord): Promise<void> {
    try {
        await fs.promises.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(r) + '\n', 'utf8')
    } catch (err) { handleFsError(err, 'index') }
}

function notifyWindow(r: LlmCallRecord): void {
    if (isWorkerThread()) {
        // Worker 线程无法访问主进程 BrowserWindow（electron 暴露面有限），
        // 经 parentPort 转发主进程，由主进程 pushToLogsWindow 推送到日志窗口。
        postToParent({type: 'llm-trace-record', record: r})
        return
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- 单测/无 electron 环境需防御式 require
        const {BrowserWindow} = require('electron')
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed() && (w as any).__isLlmLogsWindow) {
                w.webContents.send('llm-trace-record', r)
            }
        }
    } catch { /* electron 不可用（单测环境）时忽略 */ }
}

// ── 读取辅助（投影/IPC 用）──
export async function getTraceIndexLines(conversationId: string): Promise<LlmCallRecord[]> {
    const root = deps.rootDir()
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
    const convRoot = path.join(root, safeId)
    if (!fs.existsSync(convRoot)) return []
    const out: LlmCallRecord[] = []
    for (const day of fs.readdirSync(convRoot)) {
        const idx = path.join(convRoot, day, 'index.jsonl')
        if (!fs.existsSync(idx)) continue
        const lines = fs.readFileSync(idx, 'utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line) continue
            try { out.push(JSON.parse(line)) } catch {
                // 残尾容错：仅最后一行允许损坏
                if (i !== lines.length - 1) console.warn('[llm-trace] index 中段损坏行被跳过', idx)
            }
        }
    }
    return out.sort((a, b) => a.ts - b.ts)
}

/** 清空：调用方须先停录制（Task 5 接线保证顺序），此处等待句柄空闲后删目录 */
export async function clearTraceLogs(): Promise<void> {
    await waitForIdleWriters()
    const root = deps.rootDir()
    if (fs.existsSync(root)) await fs.promises.rm(root, {recursive: true, force: true})
}
