/**
 * 主进程启动能力初始化进度上报器（单例）
 *
 * 职责：仅把"能力加载阶段 / 进度"广播到渲染进程，纯展示层。
 * - 不含任何业务判断，不参与启动流程控制
 * - 阶段枚举仅覆盖主进程侧四段：plugin / agent / skill / command
 *   （MCP 连接阶段由渲染进程基于 mcpStore 自行推导，主进程不管）
 *
 * 节流：最多每 100ms 广播一次，丢弃中间态只发最新值；
 *       done()/finish() 属终态，立即无条件发出（不被节流吞掉）。
 *
 * 快照：`getSnapshot()` 返回最后一帧，供渲染进程挂载后主动拉取补齐
 *       （createWindow() 之后立即发出的前几帧，渲染端监听尚未注册，会被丢掉）。
 */

/** 主进程侧能力加载阶段 */
export type InitStage = 'plugin' | 'agent' | 'skill' | 'command'

export interface InitProgressPayload {
    stage: InitStage
    done: number
    total: number
    finished: boolean
    /** true 表示该阶段"已完成"而非"刚进入"（两者 stage 字段相同，靠本字段区分） */
    completed: boolean
}

/** 广播频道 */
const CHANNEL = 'system:init-progress'
/** 节流窗口（毫秒） */
const THROTTLE_MS = 100

/** 广播传输实现（由主进程入口注入；未注入时静默丢弃，例如 Agent Worker 内） */
type InitProgressTransport = (channel: string, payload: unknown) => void

let transport: InitProgressTransport | null = null

/**
 * 注入广播传输实现（必须在主进程入口 src/main/index.ts 调用）。
 *
 * 刻意不在此处直接 import utils/windowBroadcast：本模块会随 powerManager 进入
 * Agent Worker 的静态依赖闭包，顶层 import 会把 electron 静态引入 worker，
 * 违反 tests/main/deps/workerNoElectron.test.ts 的隔离约束。
 */
export function setInitProgressTransport(t: InitProgressTransport): void {
    transport = t
}

class InitProgressReporter {
    /** 节流延迟发送定时器 */
    private timer: NodeJS.Timeout | null = null
    /** 上次实际广播时间戳 */
    private lastEmitAt = 0
    /** 节流窗口内待发的最新一帧 */
    private pending: InitProgressPayload | null = null
    /** 最后进入的阶段（finish 时用于填充 stage 字段） */
    private lastStage: InitStage = 'plugin'
    /** 最后一帧快照（供渲染端挂载后拉取补齐早期丢失的帧） */
    private lastPayload: InitProgressPayload | null = null

    /** 进入某阶段（total 未知时传 0，表示无分母） */
    stage(stage: InitStage): void {
        this.lastStage = stage
        this.emit({stage, done: 0, total: 0, finished: false, completed: false}, false)
    }

    /** 上报某阶段的逐条进度（total > 0 时渲染端显示 done/total） */
    progress(stage: InitStage, done: number, total: number): void {
        this.lastStage = stage
        this.emit({stage, done, total, finished: false, completed: false}, false)
    }

    /** 某阶段完成（立即发出，completed=true 以便渲染端区分"进入"与"完成"） */
    done(stage: InitStage): void {
        this.lastStage = stage
        this.emit({stage, done: 0, total: 0, finished: false, completed: true}, true)
    }

    /** 四段能力加载全部结束（终态，立即发出） */
    finish(): void {
        this.emit({stage: this.lastStage, done: 0, total: 0, finished: true, completed: false}, true)
    }

    /** 取最后一帧快照（未被任何事件触达时返回 null） */
    getSnapshot(): InitProgressPayload | null {
        return this.lastPayload
    }

    /**
     * 广播一帧。
     * @param force 终态强制立即发出，绕过节流
     */
    private emit(payload: InitProgressPayload, force: boolean): void {
        const now = Date.now()

        if (force) {
            // 终态：清掉挂起的中间态与定时器，立即发出
            this.clearPending()
            this.lastEmitAt = now
            this.send(payload)
            return
        }

        const elapsed = now - this.lastEmitAt
        if (elapsed >= THROTTLE_MS) {
            this.lastEmitAt = now
            this.send(payload)
            return
        }

        // 节流窗口内：只保留最新值，延迟到窗口末尾统一发出
        this.pending = payload
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null
                const p = this.pending
                this.pending = null
                if (p) {
                    this.lastEmitAt = Date.now()
                    this.send(p)
                }
            }, THROTTLE_MS - elapsed)
        }
    }

    private clearPending(): void {
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        this.pending = null
    }

    private send(payload: InitProgressPayload): void {
        // 记录快照：渲染进程挂载后可用 getSnapshot() 补齐早期丢失的帧
        this.lastPayload = payload
        // 传输未注入（worker 线程 / 入口尚未注册）时静默丢弃；
        // 广播失败不影响启动流程，这里一并兜底
        try {
            transport?.(CHANNEL, payload)
        } catch {
            // ignore
        }
    }
}

export const initProgress = new InitProgressReporter()
