/**
 * 工具执行器
 *
 * 职责：
 * - 权限检查
 * - 沙箱检查
 * - 执行工具
 * - 格式化结果
 */

import {executeTool, type ExecuteToolCall, type ExecuteToolResult, resolveToolTimeoutMs} from '../tools/executor'
import {permissionEngine} from '../tools/permission'
import type {ToolContext} from '../tools/types'

import type {AgentStreamEvent} from '../stream'
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

        // 通知工具开始
        // ★ 注入超时时间：UI 依据 timeoutMs 展示执行倒计时（agent/ask_user 无展示意义，不注入）
        const timeoutMs = resolveToolTimeoutMs(toolCall.name, toolCall.arguments)
        const toolStartEvent: AgentStreamEvent = {
            type: 'tool_start',
            toolCall: timeoutMs !== undefined ? {...toolCall, timeoutMs} : toolCall,
        }
        events.push(toolStartEvent)
        // ★ 即时推送 tool_start：controller 在 executeToolCalls 返回后才 yield execEvents，
        //   若不在此处转发，渲染进程收到时工具已结束（isRunning=false），倒计时无法显示。
        //   events 数组仍保留 tool_start（主进程累积器落库路径），两处不冲突。
        context.onEvent?.(toolStartEvent)

        // 执行工具
        const execResult = await executeTool({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments
        }, context)

        // ★ 即时推送 tool_completed：并行场景下 Promise.all 会阻塞正式 tool_result，
        //   此处先通知 UI 更新状态/停止倒计时，与 tool_start 的即时推送对称。
        context.onEvent?.({
            type: 'tool_completed',
            toolCallId: toolCall.id,
            result: execResult.result,
        })

        return {result: execResult, events}
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
