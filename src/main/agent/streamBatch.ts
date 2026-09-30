/**
 * Worker 端流式事件批量累积器（方案 C）
 *
 * 目的：把高频 text/thinking chunk 在 Worker 线程内按 32ms 窗口内容级合并，
 * 减少跨线程 postMessage 次数与结构化克隆开销（N 条 → 1 条）。
 * 带完整状态的事件（tool_use 等）立即透传，且透传前强制 flush 当前 batch 保证顺序。
 *
 * 设计要点（spec §5）：
 * - 内容级合并（C2）而非数组打包（C1）：合并后事件对象元数据克隆从 N 份降到 1 份
 * - text/thinking 语义为"追加"，渲染端本来就是逐字拼接，合并无损
 * - ★ 保序契约：缓冲为 chunk 到达序的有序段序列（相邻同型段合并，异型分段），
 *   flush 按时间序逐段 post——渲染时序 ≡ LLM 响应真实生成时序。
 *   （历史缺陷：双独立数组 + 固定"先 text 后 thinking"flush 序，同窗口内
 *   thinking chunk 被压到 text 之后，渲染端 think 块锚到"接收时正文进度"
 *   而非"思考真实发生位置"，表现为流式切表 / 重载思考块沉底 / 落库序与
 *   时间戳倒挂）
 * - 纯函数 + 依赖注入（sink/windowMs/timer），单测无需真 worker 线程
 */

import type {AgentStreamEvent} from './stream'

export interface StreamBatchSink {
    /** 发送一条事件到主进程（worker 中为 parentPort.postMessage 包装） */
    post: (event: AgentStreamEvent) => void
}

export interface StreamBatchOptions {
    windowMs?: number
    setTimeout?: typeof setTimeout
    clearTimeout?: typeof clearTimeout
}

export interface StreamBatchAccumulator {
    push: (event: AgentStreamEvent) => void
    flush: () => void
    dispose: () => void
}

export function createStreamBatchAccumulator(
    sink: StreamBatchSink,
    options: StreamBatchOptions = {},
): StreamBatchAccumulator {
    const windowMs = options.windowMs ?? 32
    const setTimer = options.setTimeout ?? setTimeout
    const clearTimer = options.clearTimeout ?? clearTimeout

    // ★ 保序缓冲：按 chunk 到达序维护有序段（相邻同型段合并内容，异型开新段）。
    //   flush 按段序 post——与固定"先 text 后 thinking"的双数组实现不同，
    //   真实交错（thinking 先 / 正文后，或真 interleaved）均保持时间序。
    let parts: Array<{type: 'text' | 'thinking'; buf: string}> = []
    let timer: ReturnType<typeof setTimeout> | null = null

    function flush(): void {
        if (timer !== null) { clearTimer(timer); timer = null }
        for (const p of parts) {
            sink.post({type: p.type, content: p.buf})
        }
        parts = []
    }

    function schedule(): void {
        if (timer !== null) return
        if (parts.length === 0) return
        timer = setTimer(() => { timer = null; flush() }, windowMs)
    }

    function push(event: AgentStreamEvent): void {
        if (event.type === 'text' || event.type === 'thinking') {
            const last = parts[parts.length - 1]
            if (last && last.type === event.type) {
                last.buf += event.content
            } else {
                parts.push({type: event.type, buf: event.content})
            }
            schedule()
        } else {
            // ★ 顺序保证：other 事件（tool_use 等）到达前，先按时间序 flush 当前段序列
            //   （think 块必须先于 tool_use 到达渲染端）；other 立即透传不缓冲，
            //   保证工具事件的低延迟反馈
            flush()
            sink.post(event)
        }
    }

    function dispose(): void {
        if (timer !== null) { clearTimer(timer); timer = null }
        parts = []
    }

    return {push, flush, dispose}
}
