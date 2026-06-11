// ── HMR 持久化辅助函数 ──────────────────────────────

import {useAgentStore} from '..'
import {STREAMING_STATE} from '../defaultState'
import {syncConvToTopLevel} from './convHelpers'
import type {ConvAgentData} from '../types'

/** sessionStorage 键名：HMR 时保存运行中的 Agent 状态 */
const HMR_STORAGE_KEY = 'hclaw-agent-hmr-context'

interface HmrSavedData {
    streamingMessageId: string | null
    streamBuffer: string
    agentState: ConvAgentData['agentState']
    thinkingContent: string | null
    runningToolCount: number
    isThinkingAfterTools: boolean
}

/** HMR 前将运行中的 agent 状态持久化到 sessionStorage */
export function saveHmrContext() {
    const nonIdle: Record<string, HmrSavedData> = {}

    for (const [id, d] of Object.entries(useAgentStore.getState().convAgentStates)) {
        if (d.agentState.status === 'idle') continue
        nonIdle[id] = {
            streamingMessageId: d.streamingMessageId,
            streamBuffer: d.streamBuffer,
            agentState: d.agentState,
            thinkingContent: d.thinkingContent,
            runningToolCount: d.runningToolCount,
            isThinkingAfterTools: d.isThinkingAfterTools,
        }
    }

    if (Object.keys(nonIdle).length === 0) return
    try {
        sessionStorage.setItem(HMR_STORAGE_KEY, JSON.stringify(nonIdle))
    } catch { /* sessionStorage 配额不足时静默忽略 */ }
}

/** 从 sessionStorage 恢复 HMR 前的 agent 状态 */
export async function restoreFromHmr(): Promise<Set<string>> {
    const hmrSaved = sessionStorage.getItem(HMR_STORAGE_KEY)
    if (!hmrSaved) return new Set()

    sessionStorage.removeItem(HMR_STORAGE_KEY)
    const restored = new Set<string>()

    try {
        const savedState = JSON.parse(hmrSaved) as Record<string, HmrSavedData>
        for (const [convId, data] of Object.entries(savedState)) {
            if (useAgentStore.getState().convAgentStates[convId]?.streamingMessageId) continue

            useAgentStore.getState().updateConvData(convId, {
                streamingMessageId: data.streamingMessageId ?? null,
                streamBuffer: data.streamBuffer ?? '',
                thinkingContent: data.thinkingContent ?? null,
                runningToolCount: data.runningToolCount ?? 0,
                isThinkingAfterTools: data.isThinkingAfterTools ?? false,
                agentState: data.agentState ?? STREAMING_STATE,
            })
            syncConvToTopLevel(convId)
            restored.add(convId)
            console.log(`[agentStore] HMR 恢复 Agent 会话: ${convId}`)
        }
    } catch { /* JSON 解析失败，忽略 */ }

    return restored
}
