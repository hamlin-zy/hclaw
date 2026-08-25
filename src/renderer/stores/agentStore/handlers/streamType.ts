// ── 会话流段边界状态（轻量模块，避免 handlers 间循环依赖） ──────

/** 本会话上一事件类型（段边界检测，shouldFlushOnBoundary 依据） */
const lastStreamType = new Map<string, string>()

export function setLastStreamType(convId: string, type: string): void {
    lastStreamType.set(convId, type)
}

export function getLastStreamType(convId: string): string | undefined {
    return lastStreamType.get(convId)
}

/** 会话流结束后即时清除段边界状态（done/error 收尾调用；会话删除时兜底） */
export function clearLastStreamType(convId: string): void {
    lastStreamType.delete(convId)
}
