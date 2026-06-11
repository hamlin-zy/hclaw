import type {AgentState} from '@shared/types'
import type {ConvAgentData} from './types'

// ── Agent State 常量 ──────────────────────────────
export const IDLE_STATE: AgentState = {status: 'idle', mode: 'auto', phase: 'idle'}
export const STREAMING_STATE: AgentState = {status: 'running', mode: 'auto', phase: 'streaming'}

/** 构造通用 AgentState（组合 status + phase，其余字段默认 undefined） */
export function makeAgentState(status: AgentState['status'], phase: AgentState['phase']): AgentState {
    return {status, mode: 'auto', phase}
}

/** 创建 ConvAgentData 默认值 */
export function createDefaultConvData(): ConvAgentData {
    return {
        agentState: {...IDLE_STATE, currentModelName: undefined, currentModelProvider: undefined},
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        streamingMessageId: null,
        isThinkingAfterTools: false,
        runningToolCount: 0,
        pendingQuestion: null,
        toolPopupData: null,
        pendingPermissionConfirm: null,
        tasks: [],
        intentResult: null,
        errorMessage: null,
        executingToolsMessage: null,
        pendingMessages: [],
    }
}

// ── 顶层默认值（清理残留运行状态时使用） ──────────────────────
export const DEFAULT_TOP_LEVEL = {
    streamBuffer: '',
    streamingMessageId: null,
    thinkingContent: null,
    streamBlocks: [],
    isThinkingAfterTools: false,
    runningToolCount: 0,
    tasks: [],
    errorMessage: null,
}
