/**
 * tools 变动确认门：向主进程投递确认请求并等待用户决策。
 *
 * ★ 与 ask_user 门同构：无限等待用户决策，**不设任何自动放行超时**。
 *   用户未应答则 Agent 永久阻塞在该门，直到用户做出选择（settle）。
 *   唯一在线兜底是 abort / worker 退出：届时由 cancelAll() 按 'cancel' 结算，
 *   阻断本轮发送（用户已中止，本就不该继续）。
 *
 * ★ 刷新恢复配套：无限等待下，「renderer 刷新/崩溃 → worker 仍阻塞 → 弹窗不重现
 *   → 无人应答 → 永久死锁」是必须堵住的链路。渲染端靠主进程内存快照 + 启动播种
 *   重现弹窗（见 manager.accumulator.buildStreamSnapshot 的 pendingToolsChangeConfirm
 *   字段，与 pendingQuestion 完全同构），保证任何会话都有应答路径。
 */
export type ToolsChangeDecision = 'continue' | 'cancel' | 'snooze_today'

export interface ToolsChangeConfirmerOptions {
    /** 向主进程投递确认请求 */
    post: (msg: {
        type: string
        conversationId: string
        requestId: string
        added: string[]
        removed: string[]
    }) => void
    /** 请求消息类型常量（WORKER_MESSAGE_TYPES.TOOLS_CHANGE_CONFIRM） */
    messageType: string
    conversationId: string
    /** 是否已中止：中止时直接按 cancel 结束，不发送请求 */
    isAborted: () => boolean
}

export class ToolsChangeConfirmer {
    /** requestId → 结算回调（resolve 该请求的 Promise） */
    private readonly pending = new Map<string, (decision: ToolsChangeDecision) => void>()

    constructor(private readonly opts: ToolsChangeConfirmerOptions) {}

    /** 发起确认请求，无限期等待用户决策；仅 settle() 或 cancelAll() 能结算。 */
    request(info: {added: string[]; removed: string[]}): Promise<ToolsChangeDecision> {
        return new Promise<ToolsChangeDecision>((resolve) => {
            if (this.opts.isAborted()) {
                resolve('cancel')
                return
            }

            const requestId = Math.random().toString(36).substring(7)
            let settled = false
            const finish = (decision: ToolsChangeDecision) => {
                if (settled) return
                settled = true
                resolve(decision)
            }

            this.pending.set(requestId, finish)
            this.opts.post({
                type: this.opts.messageType,
                conversationId: this.opts.conversationId,
                requestId,
                added: info.added,
                removed: info.removed,
            })
        })
    }

    /** 主进程返回用户决策 */
    settle(requestId: string, decision: ToolsChangeDecision): void {
        const finish = this.pending.get(requestId)
        if (!finish) return
        this.pending.delete(requestId)
        finish(decision)
    }

    /** 中止：所有待处理请求按 cancel 结束 */
    cancelAll(): void {
        const all = [...this.pending.values()]
        this.pending.clear()
        for (const finish of all) finish('cancel')
    }
}
