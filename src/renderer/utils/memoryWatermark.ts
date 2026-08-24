// src/renderer/utils/memoryWatermark.ts — spec §3.1 水位监控（渲染侧）
// 设计约束：本模块不得 import 任何 store（避免循环依赖），指标由各 store 注册。
type SourceFn = () => Record<string, number>
const sources = new Map<string, SourceFn>()

export function registerMemorySource(name: string, fn: SourceFn): () => void {
    sources.set(name, fn)
    return () => {sources.delete(name)}
}

export function collectWatermark(): Record<string, number> {
    const perf = performance as any
    const out: Record<string, number> = perf.memory
        ? {heapUsedMB: Math.round(perf.memory.usedJSHeapSize / 1048576)}
        : {}
    for (const [name, fn] of sources) {
        try {
            for (const [k, v] of Object.entries(fn())) out[`${name}.${k}`] = v
        } catch { /* 单源失败不阻断其余采集 */ }
    }
    return out
}

let timer: ReturnType<typeof setInterval> | null = null

/** dev-only：启动水印定时输出（经 console-message 由主进程转发落盘） */
export function startWatermarkTimer(intervalMs = 30_000): void {
    if (!import.meta.env.DEV || timer) return
    timer = setInterval(() => {
        console.info('[mem-watermark]', JSON.stringify(collectWatermark()))
    }, intervalMs)
}
