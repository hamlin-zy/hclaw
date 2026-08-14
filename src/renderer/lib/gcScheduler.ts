/**
 * 闲置期自动 GC 调度器（渲染进程）
 *
 * 从 App.tsx 提取的可测试模块：
 * - 手动 window.gc() 仅在 3 个条件同时满足时触发：
 *   1. 距上次 GC ≥ MIN_GC_INTERVAL
 *   2. 页面非 hidden（最小化/隐藏期间不 GC——requestIdleCallback 本就被节流，
 *      显式门控防止恢复瞬间触发；V8 自动 GC 不受影响，不会 OOM）
 *   3. 距最近一次 hidden→visible 恢复 ≥ POST_VISIBLE_GRACE_MS
 *      （恢复后积压流式事件还在消化，立即 GC 会抢主线程造成 UI 卡顿）
 * - 纯逻辑：所有副作用（gc/requestIdleCallback/timer）通过依赖注入，
 *   便于单测验证门控时序。
 */

export interface GcSchedulerDeps {
    /** 页面是否隐藏（document.hidden 语义） */
    isHidden: () => boolean
    /** 当前时间戳 */
    now: () => number
    /** 请求空闲回调（返回是否成功调度） */
    requestIdle: (cb: (didTimeout: boolean) => void, timeout: number) => boolean
    /** 执行 GC（window.gc） */
    runGc: () => void
    /** 注册 hidden→visible 恢复回调 */
    onVisible: (cb: () => void) => () => void
    /** 注册定时器 */
    scheduleInterval: (cb: () => void, ms: number) => void
    scheduleTimeout: (cb: () => void, ms: number) => void
}

export const MIN_GC_INTERVAL_MS = 45000
export const POST_VISIBLE_GRACE_MS = 60000

export function createGcScheduler(deps: GcSchedulerDeps): {tryGc: () => void} {
    let lastGc = 0
    let lastVisibleAt = deps.now()

    const tryGc = () => {
        const now = deps.now()
        if (now - lastGc < MIN_GC_INTERVAL_MS) return
        if (deps.isHidden()) return
        if (now - lastVisibleAt < POST_VISIBLE_GRACE_MS) return
        deps.requestIdle((didTimeout) => {
            if (didTimeout) return
            deps.runGc()
            lastGc = now
        }, 5000)
    }

    deps.onVisible(() => {
        lastVisibleAt = deps.now()
    })
    deps.scheduleInterval(tryGc, 60000)
    deps.scheduleTimeout(tryGc, 15000)

    return {tryGc}
}
