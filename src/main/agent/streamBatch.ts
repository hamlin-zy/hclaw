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

    let textParts: string[] = []
    let thinkingParts: string[] = []
    let timer: ReturnType<typeof setTimeout> | null = null

    function flush(): void {
        if (timer !== null) { clearTimer(timer); timer = null }
        if (textParts.length > 0) {
            sink.post({type: 'text', content: textParts.join('')})
            textParts = []
        }
        if (thinkingParts.length > 0) {
            sink.post({type: 'thinking', content: thinkingParts.join('')})
            thinkingParts = []
        }
    }

    function schedule(): void {
        if (timer !== null) return
        if (textParts.length === 0 && thinkingParts.length === 0) return
        timer = setTimer(() => { timer = null; flush() }, windowMs)
    }

    function push(event: AgentStreamEvent): void {
        if (event.type === 'text') {
            textParts.push(event.content)
            schedule()
        } else if (event.type === 'thinking') {
            thinkingParts.push(event.content)
            schedule()
        } else {
            // ★ 顺序保证：other 事件（tool_use 等）到达前，先 flush 当前 text/thinking
            //   batch（think 块必须先于 tool_use 到达渲染端）；other 立即透传不缓冲，
            //   保证工具事件的低延迟反馈
            flush()
            sink.post(event)
        }
    }

    function dispose(): void {
        if (timer !== null) { clearTimer(timer); timer = null }
        textParts = []
        thinkingParts = []
    }

    return {push, flush, dispose}
}
