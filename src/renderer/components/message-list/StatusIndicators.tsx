/**
 * 阶段文案常量与工具函数（供 MessageList 气泡内 statusNote 复用）
 */

// ── 常量 ────────────────────────────────────────────────────────────────────
/** 阶段文案（导出供 MessageList 气泡内 statusNote 复用） */
export const PHASE_LABELS: Record<string, string> = {
    starting: '启动中...',
    streaming: '思考中',
    executing_tools: '执行工具中',
    responding: '响应中...',
    waiting_for_response: '等待响应中...',
}

/** 阶段 → 文案（导出供气泡 statusNote 复用） */
export function getPhaseLabel(phase: string | undefined): string {
    if (!phase || phase === 'idle') return ''
    return PHASE_LABELS[phase] ?? '思考中'
}
