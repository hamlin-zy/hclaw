import {create} from 'zustand'
import {useMcpStore} from './mcpStore'

/**
 * 启动能力初始化阶段 store（纯展示层）
 *
 * 数据来源：
 * - 主进程四段（plugin/agent/skill/command）→ IPC 频道 system:init-progress
 * - MCP 连接阶段 → 复用 mcpStore 的 server 列表（总数）与状态（已连接数），
 *   "MCP 阶段已开始"以收到过任意一条 mcp:status-changed 为信号
 *
 * 15s 硬超时：从首次收到进度起算，超时后强制 active=false，
 * 保证 MCP 慢启动不会让提示常驻。
 */

interface InitProgressState {
    /** 当前展示阶段 */
    stage: string | null
    /** 当前阶段已完成条目数 */
    done: number
    /** 当前阶段总条目数（0 表示无分母） */
    total: number
    /** 是否处于能力初始化阶段（用于展示） */
    active: boolean
    /** MCP 已连接数 */
    mcpDone: number
    /** MCP 总数（仅统计启用项） */
    mcpTotal: number
}

const TIMEOUT_MS = 15000

// ── 模块级状态（不是 React state，供订阅回调读写） ──
let mainStarted = false
let mainFinished = false
let mainStage: string | null = null
let mainDone = 0
let mainTotal = 0
let mcpStarted = false
let mcpDone = 0
let mcpTotal = 0
let timedOut = false
let settled = false
let timer: ReturnType<typeof setTimeout> | null = null

// 已注册监听器的注销函数（模块级持有，供 dispose 统一释放，避免 HMR/重复 import 叠加）
const listenerUnsubs: Array<() => void> = []
let listenersRegistered = false

/** 记录监听器返回的注销函数（IPC 通道不可用时返回 undefined，忽略即可） */
function trackUnsub(unsub: unknown): void {
    if (typeof unsub === 'function') listenerUnsubs.push(unsub as () => void)
}

export const useInitProgressStore = create<InitProgressState>(() => ({
    stage: null,
    done: 0,
    total: 0,
    active: false,
    mcpDone: 0,
    mcpTotal: 0,
}))

/** 根据模块级状态推导当前展示态 */
function derive(): { active: boolean; stage: string | null; done: number; total: number } {
    if (timedOut || settled) return {active: false, stage: null, done: 0, total: 0}

    const mcpActive = mcpStarted && mcpTotal > 0 && mcpDone < mcpTotal

    if (mainStarted && !mainFinished) {
        return {active: true, stage: mainStage, done: mainDone, total: mainTotal}
    }
    if (mcpActive) {
        return {active: true, stage: 'mcp', done: mcpDone, total: mcpTotal}
    }
    return {active: false, stage: null, done: 0, total: 0}
}

function clearTimer(): void {
    if (timer) {
        clearTimeout(timer)
        timer = null
    }
}

/** 落库并同步计时器：主进程结束且 MCP 无未完成项后不再展示 */
function refresh(): void {
    // 启动阶段已彻底结束（主进程四段完成 + MCP 全部连接）→ 永久关闭，避免运行期 MCP 重连误触发
    if (mainFinished && mcpTotal > 0 && mcpDone >= mcpTotal) {
        settled = true
        clearTimer()
    }
    const d = derive()
    useInitProgressStore.setState({
        active: d.active,
        stage: d.stage,
        done: d.done,
        total: d.total,
        mcpDone,
        mcpTotal,
    })
}

/** 首次收到进度时启动 15s 硬超时 */
function armTimeout(): void {
    // 已超时/已结算后不再重复挂定时器（后续 MCP 状态变化会频繁触发本函数）
    if (timer || timedOut || settled) return
    timer = setTimeout(() => {
        timer = null
        timedOut = true
        refresh()
    }, TIMEOUT_MS)
}

/** 主进程四段进度帧的形状（与 preload 暴露的类型一致） */
interface MainProgressPayload {
    stage: string
    done: number
    total: number
    finished: boolean
    completed: boolean
}

/** 注册 IPC / store 监听（模块顶层同步注册，避免错过早期事件） */
function registerInitListeners(): void {
    if (typeof window === 'undefined') return
    // 幂等守卫：HMR / 重复 import 时避免订阅叠加
    if (listenersRegistered) return
    listenersRegistered = true

    // 主进程四段能力加载进度
    const applyMainProgress = (payload: MainProgressPayload | null | undefined): void => {
        if (!payload) return
        // 首次启动的四段已结束：忽略其后的杂散事件
        // （powerManager.refresh() 等运行期刷新会再次发 stage，不应把提示重新点亮）
        if (mainFinished) return
        mainStarted = true
        if (payload.finished) {
            mainFinished = true
        } else if (!payload.completed) {
            // completed=true 仅表示"某阶段完成"，不改变当前展示的阶段
            mainStage = payload.stage
        }
        mainDone = payload.done
        mainTotal = payload.total
        armTimeout()
        refresh()
    }

    trackUnsub(window.electronAPI?.system?.onInitProgress?.(applyMainProgress))

    // 挂载后补拉一次快照：createWindow() 之后立即发出的前几帧
    // 因渲染端尚未注册监听而被 IPC 丢弃，靠这里补齐
    window.electronAPI?.system?.getInitProgress?.()
        ?.then(applyMainProgress)
        ?.catch(() => { /* 拉取失败不影响展示 */ })

    // MCP 阶段已开始信号（复用现有 mcp:status-changed 通道）
    trackUnsub(window.electronAPI?.mcp?.onStatusChanged?.(() => {
        if (!mcpStarted) {
            mcpStarted = true
            armTimeout()
        }
        refresh()
    }))

    // 复用 mcpStore 的 server 列表与实时状态，推导 MCP 进度
    trackUnsub(useMcpStore.subscribe((state) => {
        const servers = state.mcpServers || []
        // 口径必须对称：分子分母都只看启用项，否则被禁用但仍短暂停留在
        // 'connected' 的服务器会让 done 提前达标，提示过早消失
        const enabledServers = servers.filter((s) => s.enabled !== false)
        const total = enabledServers.length
        const done = enabledServers.filter((s) => s.status === 'connected').length
        if (total === mcpTotal && done === mcpDone) return
        mcpTotal = total
        mcpDone = done
        refresh()
    }))
}

/** 注销 init 进度相关的全部监听（供 HMR / 模块卸载调用；幂等，可重复调用） */
export function disposeInitProgressListeners(): void {
    for (const unsub of listenerUnsubs) {
        try {
            unsub()
        } catch { /* 忽略重复注销 */ }
    }
    listenerUnsubs.length = 0
    listenersRegistered = false
}

registerInitListeners()

// HMR：模块被热替换前先注销旧实例的监听，避免新旧模块的订阅在页面上叠加
import.meta.hot?.dispose(() => {
    disposeInitProgressListeners()
})
