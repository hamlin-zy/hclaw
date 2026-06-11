// ── 流式事件处理共享上下文 ─────────────────────────────

import type {AgentStore} from '../types'

export type SetFn = (...args: any[]) => any
export type GetFn = () => AgentStore

/** 每个流式事件 handler 接收的共享上下文 */
export interface StreamCtx {
    set: SetFn
    get: GetFn
    convId: string
    isActiveConv: boolean
    isAgentAborted: boolean
    event: any
}
