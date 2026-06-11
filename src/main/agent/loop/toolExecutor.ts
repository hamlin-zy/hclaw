/**
 * 工具执行器
 *
 * 职责：
 * - 权限检查
 * - 沙箱检查
 * - 执行工具
 * - 格式化结果
 * - 触发 Hook（beforeToolCall/afterToolCall + PreToolUse/PostToolUse）
 */

import {executeTool, type ExecuteToolCall, type ExecuteToolResult} from '../tools/executor'
import {permissionEngine} from '../tools/permission'
import type {ToolContext} from '../tools/types'

import type {AgentStreamEvent} from '../stream'
import {hookExecutor} from '../../plugin/hooks'
import {logger} from '../logger'
import {createToolResultMessage, addMessage} from '../state'
import type {ChatMessage, LoopState} from '../state'

export interface ToolExecutionContext {
    workingDir: string
    abortSignal?: AbortSignal
    requestConfirmation?: (message: string) => Promise<'allow' | 'always' | 'deny'>
    askUserQuestion?: (question: string, options?: string[], multiSelect?: boolean) => Promise<string>
    onEvent?: (event: any) => void
}

export interface ToolExecutionResult {
    result: ExecuteToolResult
    events: AgentStreamEvent[]
}

export class ToolExecutor {
    /**
     * 执行单个工具调用
     */
    async execute(
        toolCall: ExecuteToolCall,
        context: ToolContext,
    ): Promise<ToolExecutionResult> {
        const events: AgentStreamEvent[] = []
        // 从 sendMessage 中提取 sessionId（如果有）
        const sessionId = (toolCall as any).conversationId || 'unknown'

        // ── 触发 PreToolUse hook ──
        try {
            const preToolResult = await hookExecutor.execute('PreToolUse', {
                sessionId,
                toolName: toolCall.name,
                args: toolCall.arguments,
            })

            // 如果 PreToolUse hook 阻止
            if (!preToolResult.allowed) {
                events.push({
                    type: 'tool_denied',
                    toolCallId: toolCall.id,
                    reason: preToolResult.error || 'Blocked by PreToolUse hook'
                })
                return {
                    result: {
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        denied: true,
                        denyReason: preToolResult.error || 'Blocked by PreToolUse hook',
                        result: {
                            success: false,
                            output: null,
                            error: preToolResult.error || 'Blocked by PreToolUse hook'
                        }
                    },
                    events
                }
            }

            // 如果 hook 修改了参数，使用修改后的参数
            if (preToolResult.modified?.args) {
                toolCall = {
                    ...toolCall,
                    arguments: preToolResult.modified.args as Record<string, unknown>
                }
            }
        } catch (err) {
            logger.warn('[ToolExecutor] PreToolUse hook failed', { error: err })
        }

        // 通知工具开始
        events.push({type: 'tool_start', toolCall})

        // ── 触发 PermissionRequest Hook ──
        hookExecutor.execute('PermissionRequest', {
            sessionId,
            toolName: toolCall.name,
            args: toolCall.arguments,
        }).catch(() => {})

        // 执行工具
        const execResult = await executeTool({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments
        }, context)

        // ── 触发 PermissionDenied Hook（如果被拒绝）──
        if (execResult.denied) {
            hookExecutor.execute('PermissionDenied', {
                sessionId,
                toolName: toolCall.name,
                args: toolCall.arguments,
                error: execResult.denyReason || 'Permission denied',
            }).catch(() => {})
        }

        // ── 触发 PostToolUse hook ──
        const postHookResult = await this.triggerPostToolUse(sessionId, toolCall, execResult)

        // 如果 hook 返回了 updatedToolOutput，覆盖原始结果
        if (postHookResult?.updatedToolOutput) {
            execResult.result = {
                ...execResult.result,
                ...postHookResult.updatedToolOutput,
            }
        }

        return {result: execResult, events}
    }

    /**
     * 触发 PostToolUse hook
     * @returns PostToolUse 的 HookResult（含 updatedToolOutput），失败时返回 null
     */
    private async triggerPostToolUse(
        sessionId: string,
        toolCall: ExecuteToolCall,
        execResult: ExecuteToolResult
    ): Promise<any | null> {
        const hookContext = {
            sessionId,
            toolName: toolCall.name,
            args: toolCall.arguments,
            result: execResult.result,
            error: execResult.denied ? (execResult as any).denyReason : undefined,
        }

        if (execResult.denied || execResult.result.error) {
            // 工具执行失败，触发 PostToolUseFailure
            await hookExecutor.execute('PostToolUseFailure', hookContext)
            return null
        } else {
            // 工具执行成功，触发 PostToolUse
            const result = await hookExecutor.execute('PostToolUse', hookContext)

            // ── 触发 FileChanged（文件写入类工具）──
            const fileWriteTools = ['Write', 'Edit', 'MultiEdit', 'file_edit', 'file_write', 'file_patch']
            if (fileWriteTools.includes(toolCall.name)) {
                const filePath = (toolCall.arguments as any)?.filePath
                if (filePath) {
                    hookExecutor.execute('FileChanged', {
                        sessionId,
                        toolName: toolCall.name,
                        filePath,
                    }).catch(() => {})
                }
            }

            return result
        }
    }

    /**
     * 处理工具执行结果（不可变操作）
     * @returns 新的 state 和事件数组
     */
    processResult(
        execResult: ExecuteToolResult,
        toolCall: ExecuteToolCall,
        state: LoopState,
    ): { state: LoopState; events: AgentStreamEvent[]; injectedMessage?: ChatMessage } {
        const events: AgentStreamEvent[] = []
        let newState = state
        let injectedMessage: ChatMessage | undefined

        if (execResult.denied) {
            const reason = (execResult as any).denyReason || '用户已拒绝执行该操作'
            events.push({
                type: 'tool_denied',
                toolCallId: toolCall.id,
                reason
            })

            // 即使被拒绝，也要给 LLM 一个 tool 响应，否则它感知不到失败原因
            newState = addMessage(newState, createToolResultMessage(toolCall.id, toolCall.name, {
                success: false,
                output: null,
                error: `[PERMISSION_DENIED] ${reason}`
            }))

            return { state: newState, events }
        }

        // 工具执行成功
        const isSkillTool = toolCall.name === 'skill'
        events.push({
            type: 'tool_result',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            // 对于 skill 工具，从 result._skillMeta.skillName 获取技能名称用于 UI 显示
            skillName: isSkillTool ? (execResult.result as any)?._skillMeta?.skillName : undefined,
            result: execResult.result
        })

        // 添加工具结果消息
        newState = addMessage(newState, createToolResultMessage(toolCall.id, toolCall.name, execResult.result))

        // 处理注入消息（延迟到所有工具结果之后，避免打断 tool_use/tool_result 配对）
        if (execResult.result.injectMessage) {
            const injectedMsg = execResult.result.injectMessage
            injectedMessage = {
                role: injectedMsg.role,
                content: injectedMsg.content,
            } as ChatMessage
        }

        // 处理任务列表更新
        if (execResult.result.tasks && execResult.result.tasks.length > 0) {
            events.push({type: 'tasks_update', tasks: execResult.result.tasks})
        }

        return { state: newState, events, injectedMessage }
    }

    /**
     * 检查是否有工具需要串行执行
     * file_edit 工具必须串行执行，避免文件竞争问题
     */
    needsSerialExecution(
        toolCalls: ExecuteToolCall[],
        hasConfirmationRequired: boolean
    ): boolean {
        const hasFileEdit = toolCalls.some(tc => tc.name === 'file_edit')
        return hasConfirmationRequired || hasFileEdit
    }

    /**
     * 检查是否有工具需要确认
     */
    hasConfirmationRequired(
        toolCalls: ExecuteToolCall[],
        toolRegistry: { get: (name: string) => any }
    ): boolean {
        return toolCalls.some(tc => {
            const tool = toolRegistry.get(tc.name)
            if (!tool) return false
            const permResult = permissionEngine.check(tool, tc.arguments)
            return !permResult.allowed
        })
    }

    /**
     * 处理权限被拒绝的情况（不可变操作）
     * 当用户拒绝执行某个工具时，生成拒绝事件和工具结果消息
     * @returns 新的 state 和事件数组
     */
    handlePermissionDenied(
        toolCall: ExecuteToolCall,
        reason: string,
        state: LoopState
    ): { state: LoopState; events: AgentStreamEvent[] } {
        const events: AgentStreamEvent[] = []

        events.push({
            type: 'tool_denied',
            toolCallId: toolCall.id,
            reason
        })

        // 添加工具结果消息，让 LLM 感知到失败原因
        const newState = addMessage(state, createToolResultMessage(toolCall.id, toolCall.name, {
            success: false,
            output: null,
            error: `[PERMISSION_DENIED] ${reason}`
        }))

        return { state: newState, events }
    }
}

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
    allowed: boolean
    reason?: string
    needsConfirmation?: boolean
    confirmationMessage?: string
}
