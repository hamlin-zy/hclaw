/**
 * CT 消息构建（agentDefinition 模板 → <command-task> 用户消息）
 *
 * 方案 A：agent 专属模板不再写入 system，改由 CT 消息注入消息流。
 * 幂等守卫：agentDefinition 会被跨轮恢复（cachedSystemPayload.commandId），
 * 每次 run 都会进入注入点 —— 必须与既有 CT 消息内容比对去重。
 *
 * ★ 内容必须与 commandContext 路径（entityCommandResolver.buildAgentCommandTemplate）
 *   完全一致：两者对同一 agent 应产出相同的 <command-task> 包裹版正文，否则
 *   内容去重失效，agent 指令会在"命令轮(包裹版) → 恢复轮(裸版)"间重复注入。
 */
import type {AgentDefinition} from '@shared/agent'
import type {ChatMessage} from '../model/types'
import {SOURCE_KIND_COMMAND_TASK} from '@shared/types'
import {buildAgentCommandTemplate} from '../entityCommandResolver'
import {buildCommandTaskContent} from '../utils/userContentBuilder'

/**
 * 构建 agent 模板的 CT 用户消息；无 agentDefinition（或无模板）返回 null。
 * 复刻 buildAgentCommandTemplate 的包裹版（与 commandContext 路径字节一致），
 * 从而可被 shouldInjectAgentDefinitionCt 正确去重。
 * 不渲染模板变量：与 commandContext 路径行为一致（其直接注入 commandTemplate）。
 * permissionMode 不参与（安全决策：权限模式不下发模型）。
 */
export function buildAgentDefinitionCtMessage(
    agentDefinition: AgentDefinition | undefined,
): (ChatMessage & {content: string}) | null {
    if (!agentDefinition?.systemPromptTemplate) return null
    const wrapped = buildAgentCommandTemplate({
        name: agentDefinition.agentType,
        description: agentDefinition.description,
        whenToUse: agentDefinition.whenToUse,
        model: agentDefinition.model,
        allowedTools: agentDefinition.tools,
        disallowedTools: agentDefinition.disallowedTools,
        permissionMode: agentDefinition.permissionMode,
        systemPrompt: agentDefinition.systemPromptTemplate,
    })
    return {
        id: crypto.randomUUID(),
        role: 'user',
        content: buildCommandTaskContent(wrapped),
        metadata: {sourceKind: SOURCE_KIND_COMMAND_TASK},
    } as ChatMessage & {content: string}
}

/**
 * 幂等守卫：state 中已存在内容完全相同的 CT 消息时不重复注入。
 * （commandContext 存在时由 controller 优先走 commandContext 注入，不会调用本路径。）
 */
export function shouldInjectAgentDefinitionCt(
    messages: ReadonlyArray<ChatMessage>,
    content: ChatMessage['content'],
): boolean {
    return !messages.some(
        m => (m as {metadata?: {sourceKind?: string}}).metadata?.sourceKind === SOURCE_KIND_COMMAND_TASK
            && m.content === content,
    )
}
