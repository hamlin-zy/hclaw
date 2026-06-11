// ── 通用辅助函数 ──────────────────────────────────────────

import type {SubAgentStreamEntry} from '../../toolCallsStore'

/** 将 event.result 标准化为统一格式 */
export function normalizeToolResult(raw: any) {
    const rawOutput = raw.output
    const outputStr = typeof rawOutput === 'string'
        ? rawOutput
        : (rawOutput && typeof rawOutput === 'object')
            ? JSON.stringify(rawOutput, null, 2)
            : String(rawOutput ?? '')
    return {
        success: raw.success ?? false,
        output: outputStr,
        error: raw.error,
        artifacts: raw.artifacts,
        diff: raw.diff,
    }
}

/** 从权限确认问题文本中解析命令列表 */
export function parseCommands(question: string): string[] {
    try {
        // 格式1: "需要确认以下命令：\n\n- command1\n- command2"
        const cmdMatch = question.match(/需要确认以下命令：\n\n([\s\S]*?)(?:\n\n|$)/)
        if (cmdMatch) {
            return cmdMatch[1]
                .split('\n')
                .map(c => c.trim())
                .filter(c => c.startsWith('- '))
                .map(c => c.slice(2))
        }

        // 格式2: 纯命令列表
        return question.split('\n')
            .map(c => c.trim())
            .filter(c => c.length > 0 && !c.includes('：') && !c.includes(':') && !c.includes('确认'))
    } catch {
        return []
    }
}

/** 将子 Agent 原始流式事件转换为 SubAgentStreamEntry */
export function toStreamEntry(raw: any): SubAgentStreamEntry | null {
    const now = Date.now()
    switch (raw?.type) {
        case 'text':
            return {type: 'text', content: raw.content, timestamp: now}
        case 'thinking':
            return {type: 'thinking', content: raw.content, timestamp: now}
        case 'tool_start':
            return {
                type: 'tool_start',
                toolName: raw.toolCall?.name,
                toolArgs: raw.toolCall?.arguments as Record<string, unknown> | undefined,
                timestamp: now,
            }
        case 'tool_result':
            return {
                type: 'tool_result',
                toolName: raw.toolName,
                content: raw.result?.output,
                isError: !!raw.result?.error,
                timestamp: now,
            }
        case 'error':
            return {type: 'error', content: raw.error, isError: true, timestamp: now}
        default:
            return null
    }
}
