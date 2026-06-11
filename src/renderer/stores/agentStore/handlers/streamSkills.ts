// ── 技能相关事件处理器 ──────────────────────────────
// skill_matched, skill_start, skill_phase, skill_reference_loaded,
// skill_script_start, skill_script_output, skill_script_done, skill_log, skill_end

import type {StreamCtx} from './streamContext'
import {useConversationStore} from '../../conversationStore'
import {useSkillStore} from '../../skillStore'

/** 获取当前会话的 streaming message ID 和 message（若有） */
function getStreamMsg(ctx: StreamCtx) {
    const convState = ctx.get().convAgentStates[ctx.convId]
    const msgId = convState?.streamingMessageId
    if (!msgId) return null
    const msgs = useConversationStore.getState().messagesMap[ctx.convId] || []
    return {msgId, msg: msgs.find(m => m.id === msgId)}
}

export function handleSkillMatched(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const skillName = typeof event.skillName === 'string' ? event.skillName : ''
    if (!event.skillId || !skillName) return
    useSkillStore.getState().onSkillMatched(event.skillId, skillName, event.reason || '')
    const result = getStreamMsg(ctx)
    if (!result) return
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            executionId: `exec-${Date.now()}`,
            skillId: event.skillId,
            skillName,
            status: 'matched',
            startTime: Date.now(),
            logs: [{
                timestamp: Date.now(),
                type: 'info',
                message: `技能匹配: ${event.reason || '自动匹配'}`,
            }],
        },
    })
}

export function handleSkillStart(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result) return
    const skillName = typeof event.skillName === 'string' ? event.skillName : ''
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            executionId: (event.skillId || '') + '-' + Date.now(),
            skillId: event.skillId || '',
            skillName,
            status: 'loading',
            phase: 'loading_main',
            startTime: Date.now(),
            logs: [{
                timestamp: Date.now(),
                type: 'info',
                message: '开始执行技能...',
            }],
        },
    })
}

export function handleSkillPhase(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result?.msg?.skillExecution) return
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            ...result.msg.skillExecution,
            status: 'executing',
            phase: event.phase,
            currentStep: event.phase,
            logs: [
                ...(result.msg.skillExecution.logs || []),
                {timestamp: Date.now(), type: 'info' as const, message: `阶段: ${event.phase}`},
            ],
        },
    })
}

export function handleSkillReferenceLoaded(ctx: StreamCtx) {
    const {isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result?.msg?.skillExecution) return
    const skillId = typeof event.skillId === 'string' ? event.skillId : ''
    if (!skillId) return
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            ...result.msg.skillExecution,
            references: {
                loaded: [...(result.msg.skillExecution.references?.loaded || []), skillId],
                pending: result.msg.skillExecution.references?.pending,
            },
            logs: [
                ...(result.msg.skillExecution.logs || []),
                {timestamp: Date.now(), type: 'info' as const, message: `已加载引用: ${skillId}`},
            ],
        },
    })
}

export function handleSkillScriptStart(ctx: StreamCtx) {
    const {isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result?.msg?.skillExecution) return
    const skillId = typeof event.skillId === 'string' ? event.skillId : ''
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            ...result.msg.skillExecution,
            script: {name: skillId, status: 'running'},
            logs: [
                ...(result.msg.skillExecution.logs || []),
                {timestamp: Date.now(), type: 'info' as const, message: `开始执行脚本: ${skillId}`},
            ],
        },
    })
}

export function handleSkillScriptOutput(ctx: StreamCtx) {
    const {isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result?.msg?.skillExecution?.script) return
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            ...result.msg.skillExecution,
            script: {
                ...result.msg.skillExecution.script,
                output: (result.msg.skillExecution.script.output || '') + (event.output || ''),
            },
        },
    })
}

export function handleSkillScriptDone(ctx: StreamCtx) {
    const {isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result?.msg?.skillExecution?.script) return
    const scriptStatus = event.script.status
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            ...result.msg.skillExecution,
            script: {name: event.script.name, status: scriptStatus, output: event.script.output},
            logs: [
                ...(result.msg.skillExecution.logs || []),
                {
                    timestamp: Date.now(),
                    type: scriptStatus === 'done' ? 'info' as const : 'error' as const,
                    message: `脚本 ${event.script.name} ${scriptStatus === 'done' ? '成功' : '失败'}`,
                },
            ],
        },
    })
}

export function handleSkillLog(ctx: StreamCtx) {
    const {isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result?.msg?.skillExecution) return
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            ...result.msg.skillExecution,
            logs: [
                ...(result.msg.skillExecution.logs || []),
                {timestamp: Date.now(), type: event.level, message: event.message},
            ],
        },
    })
}

export function handleSkillEnd(ctx: StreamCtx) {
    const {isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const result = getStreamMsg(ctx)
    if (!result?.msg?.skillExecution) return
    useConversationStore.getState().updateMessageForConv(ctx.convId, result.msgId, {
        skillExecution: {
            ...result.msg.skillExecution,
            status: event.status,
            endTime: Date.now(),
            result: event.result ? {type: event.result.type, content: event.result.content ?? ''} : undefined,
            error: event.error,
            logs: [
                ...(result.msg.skillExecution.logs || []),
                {
                    timestamp: Date.now(),
                    type: event.status === 'done' ? 'info' as const : 'error' as const,
                    message: `技能执行${event.status === 'done' ? '完成' : '失败'}`,
                },
            ],
        },
    })
}
