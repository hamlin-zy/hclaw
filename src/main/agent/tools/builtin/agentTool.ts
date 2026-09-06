/**
 * agent 内置工具 — 派生子 Agent 执行子任务
 *
 * 主 Agent 通过调用此工具派生子 Agent，支持：
 * - 任务描述（prompt）
 * - agent 参数（必填，指定子 Agent 名称；从 agentRegistry 中查找，
 *   未找到时返回错误 + 可用列表，强制 LLM 修正重试，不静默回退）
 * - 可选的 tools 参数（指定工具白名单，可覆盖 Agent 定义）
 * - 独立会话（子 Agent 拥有独立的 conversation，与父会话单向关联，侧栏可见）
 *
 * 执行策略：
 * - 子会话创建于 SQLite（持久化，侧栏可见）
 * - agentLoop 在当前进程/线程中运行（不使用独立 Worker）
 * - 通过 context.sendMessage() 转发子 Agent 事件（流式进度卡片）
 * - 子会话的完整对话历史写入 SQLite（用户可在侧栏回溯查看）
 *
 * 递归深度：通过 parentConvId 链追踪，达到 maxDepth 上限时拒绝。
 * 并发：由 LLM 原生 parallel function call 限制 + 本地计数器兜底。
 */

import {z} from 'zod'
import {randomUUID} from 'crypto'
import {parentPort} from 'worker_threads'
import type {Tool, ToolResult} from '../types'
import {agentLoop} from '../../loop'
import type {AgentStreamEvent} from '../../stream'
import {logger} from '../../logger'
import {agentRegistry} from '../../agentRegistry'
import {agentTemplateToDefinition} from '../../agentTemplateConverter'
import type {AgentDefinition} from '@shared/agent'
import type {LLMProvider, ModelOverride, ModelRole, ModelScheme} from '@shared/types'
import {getRoleConfig, isTextRoleUsable, getUsableTextRoles} from '@shared/modelSchemeHelpers'
import {runtimeConfigManager} from '../../runtimeConfigManager'
import {systemSettingsRepo} from '../../../repositories/sqlite/systemSettingsRepository'
import {permissionEngine} from '../permission'
import {createConversationRepository} from '../../../repositories'
import {
    createChildConvAccumulator,
    finalizeChildConv,
    flushAccumulatorMessage,
    handleChildEvent,
} from './childConvMessages'
import {toLlmUsageRecord} from '@shared/llmUsage'
import {llmUsageRepo} from '../../../repositories/sqlite/llmUsageRepository'

// ─── 并发控制 ──────────────────────────────────────────────

const activeChildSessions = new Set<string>()

// ─── 递归深度追踪 ────────────────────────────────────────

/**
 * 沿 parentConvId 链向上追溯，计算当前会话的递归深度
 *
 * 用于防止子 Agent 无限嵌套（如 A → B → A → B...）。
 * visited 集合防止循环引用导致死循环。
 */
function getRecursionDepth(convId: string): number {
    let depth = 0
    let current = convId
    const visited = new Set<string>()
    const repo = createConversationRepository()

    while (true) {
        if (visited.has(current)) break
        visited.add(current)

        const meta = repo.readMeta(current)
        if (!meta?.parentConvId) break
        current = meta.parentConvId
        depth++
    }

    return depth
}

// ─── 输入 Schema ──────────────────────────────────────────

type AgentToolInput = { task: string; agent: string; tools?: string[]; modelRole: ModelRole }

/**
 * 解析子会话应固化的模型 override（ModelSelector 显示 + 子会话内后续轮次一致）。
 *
 * 两级决策：
 * 1. 显式 modelRole 且该文本角色可用（isTextRoleUsable，含 provider/model enabled 判定）
 *    → role 对应的 endpointId/modelId/providerName
 * 2. modelRole 缺失或不可用 → null（不固化；运行层按 traceContext 默认角色解析：
 *    子会话 lightweight（L→P→R），主会话 primary（P→L→R），见 defaultRoleForTrace）
 */
export function resolveChildConvOverride(
    modelRole: ModelRole | undefined,
    scheme: ModelScheme | null,
    providers: LLMProvider[],
): ModelOverride | null {
    // ① 显式 modelRole：仅当角色可用（含 provider/model enabled）才生效（与 schema 枚举一致）
    if (modelRole && isTextRoleUsable(scheme, providers, modelRole)) {
        const roleConfig = getRoleConfig(scheme!, modelRole)
        const provider = providers.find(p => p.id === roleConfig!.endpointId)
        return {
            endpointId: roleConfig!.endpointId,
            modelId: roleConfig!.modelId,
            providerName: provider?.name,
        }
    }

    // ② 无可用 modelRole → null（不固化），每轮按实时角色解析（默认轻量模型，链 L→P→R），
    //    保证运行中方案变更（如 lightweight 启用/禁用）下一轮即感知
    return null
}

/**
 * 当前可作为子 Agent 候选的已启用 Agent 名称：
 * - 只取已启用（getEnabled），禁用即时排除；
 * - 排除 cmd: 伪 Agent（命令注册的内部条目，与 systemPrompt/IPC 的过滤口径一致）；
 * - 与系统提示"可用能力"表的代理列同源，避免候选漂移。
 */
function getSelectableAgentNames(): string[] {
    return (agentRegistry.getEnabled() || [])
        .filter(a => !a.id.startsWith('cmd:') && a.name)
        .map(a => a.name!)
}

/**
 * modelRole 每个取值的用途指引（用于描述/schemadescription 中拼接示例）。
 * 与 shared/modelSchemeHelpers.MODEL_ROLE_INFO 的 UI 展示信息独立：此处面向 LLM 选参，
 * 措辞强调"何时选它"，而非"这个模型是什么"。
 */
type TextModelRole = 'primary' | 'lightweight' | 'reasoning'

const MODEL_ROLE_GUIDANCE: Record<TextModelRole, string> = {
    primary: '常规实现与修复的默认选项',
    lightweight: '只读调研 / 代码搜索 / 格式化 / 简单问答',
    reasoning: '复杂推理 / 架构权衡 / 深度调试分析',
}

/**
 * 动态构建 inputSchema：
 * - agent 用 enum 约束为「已启用 Agent 名称」（弱指令遵循模型只能选合法值，
 *   选错时 zod 错误信息自动携带候选列表，报错即引导）；
 * - modelRole 必填，枚举按当前方案可用文本角色实时生成（getUsableTextRoles，
 *   含 provider/model enabled 判定），每次序列化现算，方案变更即时感知；
 * - 描述中的示例与选择规则只覆盖当前可用角色，未启用角色不进入示例，
 *   避免 LLM 看到"未启用"的取值被误导填入。
 */
function buildInputSchema(): z.ZodType<AgentToolInput> {
    const agentNames = getSelectableAgentNames()
    const availableRoles = getUsableTextRoles(
        runtimeConfigManager.getScheme(),
        runtimeConfigManager.getProviders(),
    )
    return z.object({
        task: z.string().describe('子任务的完整描述（包含目标 + 参考材料）'),
        agent: (agentNames.length ? z.enum(agentNames as [string, ...string[]]) : z.string())
            .describe('必填。要作为子 Agent 运行的已启用 Agent 名称，从可选项中精确选择。类型映射：实现/修复→Implementer、审查→Code Reviewer、代码搜索/调研→Explore、架构规划→Plan、验证→Verification、模糊或跨领域→General。'),
        tools: z.array(z.string()).optional()
            .describe('允许使用的工具白名单（指定 agent 时覆盖 Agent 定义的白名单）'),
        modelRole: z.enum(availableRoles.length ? availableRoles as [ModelRole, ...ModelRole[]] : ['primary' as ModelRole])
            .describe(
                `必填。子 Agent 使用的模型档位，取值仅限当前可用文本角色：${availableRoles.join('、') || 'primary（当前无可用文本角色，请先在设置中配置）'}。` +
                '选择规则：' +
                availableRoles.map(r => `${r}：${MODEL_ROLE_GUIDANCE[r as TextModelRole]}`).join('；') +
                '。使用不在可用列表中的取值会报错并要求重选。',
            ),
    }) as z.ZodType<AgentToolInput>
}

/**
 * 动态构建工具描述（getter 实时计算，agent 启停 + 模型方案变更即时感知）：
 * - 示例名称实时取已启用 Agent 前 3 个，禁用/新增不会漂移；
 * - modelRole 示例与选择规则动态反映当前可用文本角色（getUsableTextRoles），
 *   未启用角色不出现在描述中，避免弱模型被"未启用"的取值误导；
 * - agent 与 modelRole 明确区分为"Agent 类型"与"模型档位"两组概念，
 *   消除原"角色映射"措辞与 modelRole 参数名的撞车（弱模型曾把 Explore 当 modelRole 填）。
 */
function buildAgentToolDescription(): string {
    const examples = getSelectableAgentNames().slice(0, 3)
    const exampleText = examples.length ? examples.map(n => `"${n}"`).join('、') : '"General Agent"'
    const availableRoles = getUsableTextRoles(
        runtimeConfigManager.getScheme(),
        runtimeConfigManager.getProviders(),
    )
    const roleGuidance = availableRoles.length > 0
        ? '，按任务从当前可用角色中选择：' + availableRoles.map(r => `${r}（${MODEL_ROLE_GUIDANCE[r as TextModelRole]}）`).join(' / ')
        : '，当前无可用文本角色，请先在设置中配置'
    return (
        '派生子 Agent 执行子任务（子 Agent 拥有独立推理循环和工具访问权限）。\n' +
        `【必填】agent：从可选项中精确选择一个已启用 Agent（如 ${exampleText}）。` +
        '类型映射：实现/修复→Implementer、审查→Code Reviewer、代码搜索/调研→Explore、' +
        '架构规划→Plan、验证→Verification、模糊或跨领域→General。' +
        '名称不含插件后缀，可选项之外的名称会报错重试。\n' +
        `【必填】modelRole：子 Agent 使用的模型档位${roleGuidance}。\n` +
        '【编排】① 先规划再派遣：识别关键路径上的阻塞任务与可并行旁路任务，' +
        '不把阻塞自己的任务派出去空等；② 独立步骤尽量一次并行派遣；' +
        '③ 编码优先派 Implementer（可落地）、调研才派 Explore，简单任务自己做。' +
        ' If unsure which agent fits the task, call list_agents first.'
    )
}

// ─── 工具定义 ──────────────────────────────────────────────

export const agentTool: Tool<AgentToolInput, string> = {
    name: 'agent',
    // getter 实时构建：agent 启停/新增即时反映到描述，禁用角色不会进入候选示例
    get description() { return buildAgentToolDescription() },
    // getter 现算：与 description 同构，每次工具定义被序列化时实时反映当前方案的可用角色枚举
    get inputSchema() { return buildInputSchema() },
    isDestructive: false,

    async execute(args, context): Promise<ToolResult<string>> {
        // ①.1 校验 modelRole（必传）：必须是当前方案中可用的文本角色
        {
            const currentScheme = runtimeConfigManager.getScheme()
            const currentProviders = runtimeConfigManager.getProviders()
            const availableRoles = getUsableTextRoles(currentScheme, currentProviders)
            // modelRole 必传：缺失时给出可行动的错误（zod 通常已拦截，此处防御）
            if (!args.modelRole) {
                return {
                    success: false,
                    output: '',
                    error: `modelRole 为必填参数：请指定子 Agent 使用的模型角色。当前可用角色：${availableRoles.join(', ') || '无（模型方案中无任何可用文本角色，请先在设置中配置）'}。选择规则：只读调研/格式化/简单问答→lightweight；深度推理/架构权衡/复杂调试→reasoning；常规实现与修复→primary。`,
                }
            }
            // 角色不可用（未启用 / 服务商已禁用 / 模型已禁用）→ 明确告知原因
            if (!isTextRoleUsable(currentScheme, currentProviders, args.modelRole as ModelRole)) {
                return {
                    success: false,
                    output: '',
                    error: availableRoles.length === 0
                        ? '当前模型方案无可用的文本角色，请检查模型方案配置（角色需启用，且其服务商与模型均需启用）。'
                        : `modelRole "${args.modelRole}" 不可用（未启用，或其服务商/模型已禁用）。当前方案可用角色：${availableRoles.join(', ')}。请从可用角色中选择并重试。`,
                }
            }
        }

        // ② 解析 agent（必填）→ 转换为 AgentDefinition
        //    未找到或已禁用时返回错误 + 可用 Agent 列表（已过滤 cmd: 伪 Agent），
        //    强制 LLM 修正后重试（不静默回退 General）
        const template = agentRegistry.find(args.agent)
        if (!template || !template.enabled) {
            const available = (agentRegistry.getEnabled() || [])
                .filter(a => !a.id.startsWith('cmd:') && a.name && a.name !== 'General')
                .map(a => a.name!)
            return {
                success: false,
                output: '',
                error: `Agent "${args.agent}" 不存在或已禁用。请从以下可用 Agent 中选择一个并重试：${available.join(', ') || 'General Agent'}`,
            }
        }
        const agentName = template.name
        const agentDefinition = agentTemplateToDefinition(template)

        // ③ tools 覆盖：同时指定 agent 和 tools 时，tools 覆盖 Agent 定义的白名单
        const effectiveAgentDefinition = args.tools
            ? {...agentDefinition, tools: args.tools}
            : agentDefinition

        // ④ 递归深度检查
        const settings = systemSettingsRepo.getJson<import('@shared/types').SystemSettings>('settings')
        const maxDepth = settings?.subagent?.maxDepth ?? 3
        const parentConvId = context.conversationId
        if (parentConvId) {
            const currentDepth = getRecursionDepth(parentConvId)
            if (currentDepth >= maxDepth) {
                return {
                    success: false,
                    output: '',
                    error: `已达到最大子 Agent 嵌套深度 (${maxDepth})，无法继续派生`,
                }
            }
        }

        // ⑤ 并发检查（本地计数器 + 设置中的 maxConcurrency）
        const maxConcurrency = settings?.subagent?.maxConcurrency ?? 3
        if (activeChildSessions.size >= maxConcurrency) {
            return {
                success: false,
                output: '',
                error: `并发上限已满 (最多 ${maxConcurrency} 个子 Agent)，请稍后重试`,
            }
        }

        // ⑥ 创建子会话
        const childConvId = `conv-${randomUUID()}`
        const conversationRepo = createConversationRepository()

        let workspacePath = ''
        if (parentConvId) {
            const parentMeta = conversationRepo.readMeta(parentConvId)
            workspacePath = parentMeta?.workspacePath || ''
        }

        const now = Date.now()
        conversationRepo.create(childConvId, {
            id: childConvId,
            title: `${agentName}: ${args.task.slice(0, 20)}...`,
            workspacePath,
            createdAt: now,
            updatedAt: now,
            preview: '',
            status: 'active',
            parentConvId: parentConvId || undefined,
            sourceTask: args.task,
            sourceCapability: {type: 'agent', name: agentName},
            isChildSession: true,
        })

        // ⑥.5 固化模型选择为子会话 override：
        //   ModelSelector 显示 role 对应的服务商/模型（而非 primary/父会话模型），
        //   且子会话内后续轮次（用户继续对话，无 modelRole 参数）继承同一模型，与首轮一致。
        const childOverride = resolveChildConvOverride(
            args.modelRole,
            runtimeConfigManager.getScheme(),
            runtimeConfigManager.getProviders(),
        )
        if (childOverride) {
            runtimeConfigManager.setOverride(childConvId, childOverride)
            logger.info('[AgentTool]', {
                action: 'childConvOverrideFixed',
                childConvId,
                endpointId: childOverride.endpointId,
                modelId: childOverride.modelId,
                providerName: childOverride.providerName,
            })
        }

        logger.info('[AgentTool]', {
            action: 'creatingChildConv',
            childConvId,
            parentConvId: parentConvId || '(none)',
            agentType: agentName,
            depth: parentConvId ? getRecursionDepth(parentConvId) + 1 : 1,
            task: args.task.slice(0, 80),
        })

        // 写入初始用户消息（子会话的独立历史）
        const userMsgId = `msg-${now}-${Math.random().toString(36).slice(2, 8)}`
        conversationRepo.writeMessages(childConvId, [{
            id: userMsgId,
            role: 'user',
            content: args.task,
            timestamp: now,
        }])

        // 通知渲染进程侧栏刷新（子会话已创建于 SQLite）
        notifyMainProcessChildConvCreated(childConvId, agentName, args.task, parentConvId)

        // ★ 立即推送 subagent_start（携带 toolCallId）：子会话创建成功瞬间即可让父卡片
        //   补写 taskId（taskId === childConvId），无需等第一个 subagent_progress 事件
        //   （子 Agent 首次 LLM 输出才触发，冷启动可能滞后数秒）。
        //   渲染进程 handleSubagentStart 按 toolCallId 精确定位父 agent 工具，幂等补写。
        context.sendMessage({
            type: 'subagent_start',
            taskId: childConvId,
            description: args.task,
            toolCallId: context.toolCallId,
        })

        // ⑦ 强制权限模式为 auto（子会话不弹确认框）
        // ★ disallowedTools 必须显式传递：agentTemplateToDefinition 返回的 agentDefinition
        //   包含 disallowedTools，但此处重构 effectiveAgentDef 时曾遗漏该字段，
        //   导致 agent 级黑名单（Layer 3）在子 Agent 派发路径完全失效。
        //   tools 字段（白名单）不能替代黑名单——两者是互补的纵深防御：
        //   白名单可能被 args.tools 覆盖为 ['*']，此时黑名单是唯一防线。
        const effectiveAgentDef: AgentDefinition = {
            source: 'user' as const,
            agentType: agentName,
            whenToUse: effectiveAgentDefinition.whenToUse || '',
            description: effectiveAgentDefinition.description || '',
            systemPromptTemplate: effectiveAgentDefinition.systemPromptTemplate || '',
            renderedSystemPrompt: '',
            tools: effectiveAgentDefinition.tools || args.tools,
            disallowedTools: effectiveAgentDefinition.disallowedTools,
            permissionMode: 'auto',
        }

        // ⑧ 构建 agentLoop 参数（当前进程/线程中运行）
        //    兜底 modelConfig 按请求角色解析（与子会话实际使用的模型一致；primary 可被禁用）。
        //    上方 isTextRoleUsable 已保证此处可解析，任一为空仍是配置矛盾 → 显式报错，不静默兜底。
        const roleCfg = getRoleConfig(runtimeConfigManager.getScheme()!, args.modelRole)
        const roleProvider = runtimeConfigManager.getProviders().find(p => p.id === roleCfg!.endpointId)
        if (!roleProvider) {
            return {
                success: false,
                output: '',
                error: `modelRole "${args.modelRole}" 对应的服务商不存在（endpointId="${roleCfg!.endpointId}"），请检查模型方案配置。`,
            }
        }
        const roleModel = roleProvider.models.find(m => m.id === roleCfg!.modelId)
        if (!roleModel) {
            return {
                success: false,
                output: '',
                error: `modelRole "${args.modelRole}" 对应的模型不存在（${roleProvider.name}/${roleCfg!.modelId}），请检查模型方案配置。`,
            }
        }
        const modelConfig = {
            provider: roleProvider.type,
            model: roleModel.name,
            apiKey: '',
            baseUrl: roleProvider.baseUrl || '',
        }
        const workingDir = runtimeConfigManager.getConfig().workingDir || ''
        const maxTurnsLimit = settings?.agent?.maxTurns ?? 500

        // ⑨ 在当前进程/线程中运行子 Agent（不创建独立 Worker）
        let output = ''
        let hasError = false
        let errorMsg = ''
        // ★ 子会话完整执行过程累积器：整个子 Agent 运行累积为「单条」assistant 消息
        //   （思考/工具调用/正文按时间序写入 contentBlocks，与主会话同构：1 指令 + 1 助手气泡），
        //   在 tool_result / llm_call_done 时机增量 UPSERT 同一条消息（控制落库频率），
        //   done/error 时最终写入（endedAt）。替换旧的"仅完成时写一条最终摘要"方案，
        //   保证子会话可完整回溯执行过程。
        const childAcc = createChildConvAccumulator(childConvId)

        activeChildSessions.add(childConvId)

        // ★ 向渲染进程发送子会话 begin 事件，使侧边栏显示运行状态动画。
        //   messageId 必须携带累积器固定消息 id（msg-<ts>-<rand>）：渲染端
        //   ensureStreamingMessage 以此 id 创建占位，与主进程 SQLite 增量落库
        //   消息同 id → 切换/首次打开时按 id 去重合并，不会出现
        //   「内存占位(UUID) + SQLite 快照」双轨重复气泡（不带 messageId 则
        //   begin 退化为 UUID 占位，后续事件带 id 也被忽略，双 id 并存）。
        sendChildAgentEvent(childConvId, {type: 'begin', messageId: childAcc.assistantMsgId})

        try {
            for await (const event of agentLoop({
                sessionId: childConvId,
                messages: [
                    {role: 'user', content: args.task},
                ],
                modelConfig,
                modelRole: args.modelRole,
                workingDir,
                settings: settings || undefined,
                maxTurns: maxTurnsLimit,
                agentType: agentName,
                // 子会话标识：loop 内 selectModelForTurn 据此在未显式 modelRole 时默认轻量模型
                traceContext: 'subAgent' as const,
                agentDefinition: effectiveAgentDef,
                conversationTitle: `子 Agent: ${args.task.slice(0, 50)}`,
                abortSignal: context.abortSignal,
                // ★ 关键：转发嵌套子 Agent（二级及以上）的 subagent_* 事件到父上下文。
                //   本 agentLoop 的 toolContext.sendMessage 依赖 onEvent 转发事件；
                //   若不传，嵌套 agentTool 的 context.sendMessage 变为空操作
                //   （execute.ts: if (!onEvent) return），二级子 Agent 的
                //   subagent_start/progress/done 全部丢失 → 父卡片无滚动、无子会话。
                //   toolCallId 必须替换为当前 agentTool 的 context.toolCallId
                //   （主会话中一级 agent 工具的调用 ID），渲染进程才能按 toolCallId
                //   定位到正确的一级 Agent 卡片。
                onEvent: (event: any) => {
                    if (event.type === 'subagent_start' || event.type === 'subagent_progress' || event.type === 'subagent_done') {
                        context.sendMessage({
                            ...event,
                            toolCallId: context.toolCallId,
                        })
                    }
                },
            })) {
                // ── 跳过内部事件 ──
                if (event.type === 'mode_change') continue

                // ── 累积文本输出（返回给主 Agent 的最终摘要） ──
                if (event.type === 'text') {
                    output += event.content
                }

                // ── 累积器处理（构建完整执行过程消息） ──
                const shouldFlush = handleChildEvent(childAcc, event)
                if (shouldFlush) {
                    // 轮次完成（工具结果 / LLM 调用完成）→ 增量 UPSERT 同一条累积消息
                    flushAccumulatorMessage(childAcc, conversationRepo, childConvId, false)
                }

                // ── LLM 用量落库（路径 2：子会话用量记在子会话名下，不经主进程） ──
                if (event.type === 'llm_call_done') {
                    llmUsageRepo.record(toLlmUsageRecord(event, {
                        conversationId: childConvId,
                        messageId: childAcc.assistantMsgId,   // 累积器固定消息 id
                        seq: childAcc.llmStats.length - 1,    // handleChildEvent 已 push，此处为 push 前序号
                    }))
                }

                // ── 事件分类转发给父上下文 ──
                if (event.type === 'thinking' || event.type === 'tool_start' || event.type === 'tool_progress' || event.type === 'tool_result') {
                    context.sendMessage({
                        type: 'subagent_progress',
                        taskId: childConvId,
                        toolCallId: context.toolCallId,
                        progress: formatProgress(event),
                        subAgentStreamEvent: event,
                    })
                } else if (event.type === 'done') {
                    // ★ 透传原始 done 事件（保留 reason: completed/aborted），
                    //   子会话 UI 才能正确显示中止态而非误报完成；父卡片 success 按 reason 判定
                    const doneReason = (event as {reason?: string}).reason || 'completed'
                    const isAborted = doneReason === 'aborted'
                    context.sendMessage({
                        type: 'subagent_done',
                        taskId: childConvId,
                        success: !isAborted,
                        output: isAborted ? '' : output,
                        error: isAborted ? '已中止' : undefined,
                        toolCallId: context.toolCallId,
                    })
                    sendChildAgentEvent(childConvId, event)
                    break
                } else if (event.type === 'error') {
                    hasError = true
                    errorMsg = event.error || '未知错误'
                    context.sendMessage({type: 'subagent_done', taskId: childConvId, success: false, error: errorMsg, toolCallId: context.toolCallId})
                    sendChildAgentEvent(childConvId, {type: 'done', reason: 'error'})
                    break
                }
                // 说明：嵌套子 Agent（二级及以上）的 subagent_start/progress/done
                // 由下方 agentLoop 的 onEvent 侧通道转发到父上下文，不会进入此 for-await
                // 循环（agentLoop 生成器不产出 subagent_* 事件），故此处无需再处理。

                // ★ 转发所有流事件到子会话渲染进程（text/thinking/tool_*/agent_start 等）
                //   用户切换到子会话时可以看到实时流式输出。
                //   内容事件附加累积器固定消息 id：渲染进程首个内容事件即创建同 id 消息，
                //   与主进程增量落库的 SQLite 消息 id 一致 → 运行中切换/刷新无重复气泡。
                if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_use') {
                    sendChildAgentEvent(childConvId, {
                        ...event,
                        messageId: childAcc.assistantMsgId,
                    } as AgentStreamEvent & {messageId?: string})
                } else {
                    sendChildAgentEvent(childConvId, event)
                }
            }
        } catch (err: any) {
            hasError = true
            errorMsg = err.message || String(err)
            // 异常同步到累积器（错误信息随单条消息持久化，供子会话回溯）
            childAcc.hasError = true
            childAcc.errorMsg = errorMsg
            logger.error('[AgentTool]', {action: 'childConvException', childConvId, error: errorMsg})
            // ★ 异常也通知渲染进程结束运行状态
            sendChildAgentEvent(childConvId, {type: 'done', reason: 'error'})
        } finally {
            activeChildSessions.delete(childConvId)
        }

        // ⑩ 写入子会话的辅助消息历史（最终落库）
        // ★ 完整执行过程（思考/工具调用/正文）已累积为单条 assistant 消息，
        //   运行中增量 UPSERT（tool_result / llm_call_done 时机），此处最终写入（endedAt）。
        //   空轮次（极早退出）由累积器内部兜底为占位消息。
        const finalOutput = (hasError ? '' : output.trim()) || '(无输出)'
        finalizeChildConv(childAcc, conversationRepo, childConvId)

        // 通知 UI 刷新（子会话在侧栏中出现）
        // ★ 注意：agentLoop 内已通过 notifyMainProcessChildConvCreated 首屏通知，
        //   此处再次通知确保 assistant 消息写入后侧栏预览更新
        // 主进程路径已由 notifyMainProcessChildConvCreated 覆盖，Worker 线程路径也由
        // createMessageHandler 中 child_conv_created 分发覆盖，此处仅作兜底
        notifyMainProcessChildConvCreated(childConvId, agentName, args.task, parentConvId)

        if (hasError) {
            return {
                success: false,
                output: `执行失败: ${errorMsg}`,
                error: errorMsg,
            }
        }

        // ⑪ 返回结果
        logger.info('[AgentTool]', {
            action: 'childConvCompleted',
            childConvId,
            success: true,
            outputLen: finalOutput.length,
        })

        return {
            success: true,
            output: finalOutput,
            _meta: {childConvId},
        }
    },
}

/** 格式化子 Agent 事件为人类可读文本 */
function formatProgress(event: AgentStreamEvent): string {
    switch (event.type) {
        case 'thinking': return '子 Agent 思考中...'
        case 'tool_start': {
            const tc = event.toolCall
            return tc?.name ? `🔧 ${tc.name}` : '🔧 工具调用中...'
        }
        case 'tool_progress': return `子 Agent: ${event.progress || '执行中...'}`
        case 'tool_result': {
            const out = event.result?.output
            if (out && typeof out === 'string') {
                const trimmed = out.trim()
                return trimmed.length > 60 ? trimmed.slice(0, 60) + '...' : trimmed
            }
            return '✓ 工具完成'
        }
        default: return '子 Agent 执行中...'
    }
}

/** 通用双路径发送：Worker 线程走 parentPort → 主进程转发，主进程直接 IPC 通知渲染进程 */
function sendToRenderer(workerType: string, workerPayload: Record<string, unknown>, mainChannel: string, mainPayload: Record<string, unknown>): void {
    try {
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage({type: workerType, ...workerPayload})
            return
        }
    } catch {
        // not in Worker
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- agentTool 运行在 MCP Worker 上下文，顶层 import window.ts 会把 electron 拉进 worker bundle
        const {getMainWindow} = require('../../../window')
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
            win.webContents.send(mainChannel, mainPayload)
        }
    } catch {
        // window not available
    }
}

/** 通知主进程 / 渲染进程刷新侧栏会话列表 */
function notifyMainProcessChildConvCreated(childConvId: string, agentName: string, task: string, parentConvId?: string): void {
    const title = `${agentName}: ${task.slice(0, 20)}...`
    sendToRenderer(
        'child_conv_created',
        {childConvId, title, parentConvId: parentConvId || ''},
        'child_conv_created',
        {id: childConvId, title, parentConvId: parentConvId || undefined},
    )
}

/** 向渲染进程发送子会话的 agent 生命周期事件（begin / done / error）
 *  使得侧边栏能展示子会话的运行状态动画（与父会话一致） */
function sendChildAgentEvent(childConvId: string, event: AgentStreamEvent): void {
    sendToRenderer(
        'child_agent_event',
        {conversationId: childConvId, event},
        'agent-stream',
        {conversationId: childConvId, event},
    )
}

/** 设置当前 Agent 的模型方案配置 */
export function setAgentToolConfig(): void {
    const config = runtimeConfigManager.getConfig()
    if (config.workingDir) {
        permissionEngine.setWorkingDir(config.workingDir)
    }
    // description / inputSchema 均为 getter 实时计算，无需在此重建
}
