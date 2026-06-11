// ── handleStreamEvent 实现（调度层） ──────────────────

import type {AgentStore, AgentStreamPayload} from '../types'
import {createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'

import type {StreamCtx} from './streamContext'
import {handleBegin, handleAgentStart, handleText, handleThinking} from './streamCore'
import {handleToolUse, handleToolsStart, handleToolStart, handleToolProgress, handleToolDetail, handleToolResult, handleToolDenied} from './streamTools'
import {handleAgentProgress, handleSubagentProgress, handleSubagentStart, handleSubagentDone} from './streamSubAgents'
import {handleSkillMatched, handleSkillStart, handleSkillPhase, handleSkillReferenceLoaded, handleSkillScriptStart, handleSkillScriptOutput, handleSkillScriptDone, handleSkillLog, handleSkillEnd} from './streamSkills'
import {handleIntentAnalyzed, handleModeChange, handleContextCompacted, handleCompactStatus, handleHookResult, handleCompactPersisted, handleTasksUpdate, handleLlmCallDone, handleCommandStart} from './streamSystem'
import {handleDone, handleError, handleAskUser, handleWarning, handlePermissionRulesUpdated, handlePermissionConfirm, handleUserMessageInjected} from './streamInteraction'

type SetFn = (...args: any[]) => any
type GetFn = () => AgentStore

export async function handleStreamEventImpl(set: SetFn, get: GetFn, payload: AgentStreamPayload) {
    const {event} = payload
    const convId = (payload as any).conversationId || ''

    console.log('[handleStreamEvent]', event.type, 'conversationId:', convId)

    const convStore = useConversationStore.getState()
    const isActiveConv = convId === convStore.activeConversationId

    const convData = get().convAgentStates[convId] || createDefaultConvData()
    const isAgentAborted = convData.agentState.status === 'idle' &&
        convData.streamingMessageId !== null &&
        event.type !== 'done' && event.type !== 'error'

    const ctx: StreamCtx = {set, get, convId, isActiveConv, isAgentAborted, event}

    switch (event.type) {
        case 'begin':                  handleBegin(ctx);                   break
        case 'agent_start':            handleAgentStart(ctx);              break
        case 'text':                   handleText(ctx);                    break
        case 'thinking':               handleThinking(ctx);                break
        case 'tool_use':               handleToolUse(ctx);                 break
        case 'tools_start':            handleToolsStart(ctx);              break
        case 'tool_start':             handleToolStart(ctx);               break
        case 'tool_progress':          handleToolProgress(ctx);            break
        case 'tool_detail':            handleToolDetail(ctx);              break
        case 'tool_result':            handleToolResult(ctx);              break
        case 'tool_denied':            handleToolDenied(ctx);              break
        case 'agent_progress':         handleAgentProgress(ctx);           break
        case 'subagent_progress':      handleSubagentProgress(ctx);        break
        case 'subagent_start':         handleSubagentStart(ctx);           break
        case 'subagent_done':          handleSubagentDone(ctx);            break
        case 'skill_matched':          handleSkillMatched(ctx);            break
        case 'skill_start':            handleSkillStart(ctx);              break
        case 'skill_phase':            handleSkillPhase(ctx);              break
        case 'skill_reference_loaded': handleSkillReferenceLoaded(ctx);    break
        case 'skill_script_start':     handleSkillScriptStart(ctx);        break
        case 'skill_script_output':    handleSkillScriptOutput(ctx);       break
        case 'skill_script_done':      handleSkillScriptDone(ctx);         break
        case 'skill_log':              handleSkillLog(ctx);                break
        case 'skill_end':              handleSkillEnd(ctx);                break
        case 'intent_analyzed':        handleIntentAnalyzed(ctx);          break
        case 'mode_change':            handleModeChange(ctx);              break
        case 'context_compacted':      handleContextCompacted(ctx);        break
        case 'compact_status':         handleCompactStatus(ctx);           break
        case 'hook_result':            handleHookResult(ctx);              break
        case 'compact_persisted':      await handleCompactPersisted(ctx);  break
        case 'tasks_update':           handleTasksUpdate(ctx);             break
        case 'llm_call_done':          handleLlmCallDone(ctx);             break
        case 'command_start':          handleCommandStart(ctx);            break
        case 'done':                   await handleDone(ctx);              break
        case 'error':                  handleError(ctx);                   break
        case 'ask_user':               await handleAskUser(ctx);           break
        case 'warning':                handleWarning(ctx);                 break
        case 'permission-rules-updated': await handlePermissionRulesUpdated(ctx); break
        case 'permission_confirm':     await handlePermissionConfirm(ctx); break
        case 'user_message_injected':  handleUserMessageInjected(ctx);    break
    }
}
