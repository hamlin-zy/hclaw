/**
 * session_handoff 内置工具 — 创建新会话并交接当前任务
 *
 * 当当前会话上下文过长、LLM 智力下降时使用。
 * 调用前需在对话中已生成当前任务的结构化交接总结。
 * 工具将创建新的独立会话，将交接总结作为新会话首条用户消息写入，
 * 并在新会话中自动启动 Agent 从总结处继续工作。
 *
 * 执行策略：
 * - 同步部分（本工具，立即返回）：创建会话 → 写总结消息 → 通知渲染进程新增+自动切换
 *   → 通知主进程为新会话启动独立 Worker。工具不等待新会话首轮运行完成。
 * - 异步部分（主进程 AgentManager.start）：为新会话创建独立 Worker 运行首轮，
 *   事件走标准 agent-stream 通道（begin → 流式 → done），与桌面端"新会话首条指令"同链路。
 * - 用户在新会话发消息时，AgentManager.start 会自动 abort 交接 Worker 并重建，
 *   新旧运行天然隔离，无并发冲突。
 * - 差异：meta 不设 parentConvId/isChildSession（独立顶层父会话）。
 */

import {z} from 'zod'
import {randomUUID} from 'crypto'
import {parentPort} from 'worker_threads'
import type {Tool, ToolResult} from '../types'
import type {ChatMessage} from '../../model/types'
import {logger} from '../../logger'
import {buildUserHistoryContent} from '../../utils/userContentBuilder'

const inputSchema = z.object({
    title: z.string()
        .min(1, '新会话标题不能为空')
        .describe('新会话标题，应包含任务主题（如"XX功能开发-阶段2"）'),
    handoffSummary: z.string()
        .min(1, '交接总结不能为空')
        .describe(
            '交接总结全文，将作为新会话的首条用户消息。必须包含以下结构：\n'
            + '## 任务目标（一句话描述当前任务）\n'
            + '## 已完成进度（关键里程碑，引用文件/命令）\n'
            + '## 复用清单（只写指针，禁止把内容抄进总结；无则写"无"；这些已完成，勿重复派发）\n'
            + '   - 每条的落点只能是：① 磁盘上已存在的文件完整路径；② 该次 agent 调用的 toolCallId\n'
            + '   - 严禁为交接新建任何文件（包括汇总/笔记类 md）；严禁复述子任务正文\n'
            + '   - 每条一行：一句话结论 + 落点\n'
            + '## 遗留问题（当前阻塞点 / 未完成事项）\n'
            + '## 下一步计划（新会话应从何处继续，明确第一步动作）\n'
            + '## 关键上下文（相关文件路径 / 已运行命令 / 重要决策 / 注意事项）'
        ),
    capability: z.string()
        .optional()
        .describe('可选：新会话要触发的技能名（如 brainstorming），不带 / 前缀；填代理名或未匹配到技能时视为不指定，按普通会话继续'),
    attachments: z.array(z.object({
        path: z.string().min(1).describe('附件文件的绝对路径'),
        name: z.string().describe('附件文件名（含扩展名）'),
        mimeType: z.string().optional().describe('可选：MIME 类型（如 image/png）'),
    }))
        .optional()
        .describe(
            '可选：需带到新会话的附件（从本会话工作区内**已存在**的文件中挑选，含用户提交的附件与已产出的成果文件；严禁为交接临时新建文件）。'
            + '附件会作为新会话首条用户消息的附件展示并进入首轮模型上下文（图片可直接被视觉模型查看）。'
            + '仅传仍然有效的本地文件路径；无需携带附件时省略此字段',
        ),
})

type SessionHandoffInput = z.infer<typeof inputSchema>

export const sessionHandoffTool: Tool<SessionHandoffInput, string> = {
    name: 'session_handoff',
    description:
        '当当前会话上下文过长、LLM 智力下降时使用。'
        + '调用前需在对话中已生成当前任务的结构化交接总结。'
        + '工具将创建新的独立会话，将交接总结作为新会话首条用户消息写入，'
        + '并在新会话中自动启动 Agent 从总结处继续工作。',
    inputSchema,
    isDestructive: false,

    async execute(args, context): Promise<ToolResult<string>> {
        // ① 检查模型配置
        const {runtimeConfigManager} = await import('../../runtimeConfigManager')
        const primary = runtimeConfigManager.getPrimaryProvider()
        if (!primary.isValid) {
            return {success: false, output: '', error: '模型配置未初始化'}
        }

        // ② 获取父会话 workspacePath（新会话继承工作区）
        const {createConversationRepository} = await import('../../../repositories')
        const conversationRepo = createConversationRepository()
        const parentConvId = context.conversationId
        let workspacePath = ''
        if (parentConvId) {
            const parentMeta = conversationRepo.readMeta(parentConvId)
            workspacePath = parentMeta?.workspacePath || ''
        }

        // ③ 创建新会话 meta（无 parentConvId / isChildSession → 独立顶层父会话）
        const newConvId = `conv-${randomUUID()}`
        const now = Date.now()

        const meta = {
            id: newConvId,
            title: args.title,
            workspacePath,
            createdAt: now,
            updatedAt: now,
            preview: '',
            status: 'active' as const,
            // 记录交接发起会话（区别于 parentConvId：交接新会话是独立顶层会话，
            // 此字段仅供 MessageList「←前会话」导航使用）
            handoffFromConvId: parentConvId || undefined,
        }
        if (!conversationRepo.create(newConvId, meta)) {
            return {success: false, output: '', error: '创建新会话失败'}
        }

        // ★ 交接迁移：把来源会话的活跃批次（当前待办）改绑到新会话，
        //   使新会话启动时能通过 buildTaskBatchSnapshot 从 DB 恢复待办，而非从零开始。
        //   已完成批次留在来源会话作历史（历史任务组窗口按会话分组不受破坏）。
        if (parentConvId) {
            const {migrateActiveBatch} = await import('../../../repositories/sqlite/taskBatchRepository')
            migrateActiveBatch(parentConvId, newConvId)
        }

        // ④ 写入首条 user 消息（交接总结）
        //    capability 只解析技能：命中才拼 "/技能规范名\n" 前缀触发新会话技能命令
        //    （detectCommandContext 可解析）；未命中（含填了代理名）静默不注入，不使交接失败。
        const userMsgId = `msg-${now}-${Math.random().toString(36).slice(2, 8)}`
        const capability = args.capability?.trim()?.replace(/^\/+/, '')

        // 仅技能解析：命中透传 commandId（供 UI 渲染 /技能 徽章，与 loop/setup.ts 同源）。
        // 动态 import：entityCommandResolver 会连带加载 skills loader（config/repositories 等
        // electron 绑定模块），顶层静态加载会破坏本工具的 schema 单测环境。
        let skillMatch: Awaited<ReturnType<typeof import('../../entityCommandResolver').resolveSkillCommand>> = null
        if (capability) {
            try {
                const {resolveSkillCommand} = await import('../../entityCommandResolver')
                skillMatch = resolveSkillCommand(capability)
            } catch (err) {
                logger.debug('[SessionHandoffTool] resolveSkillCommand failed', {error: String(err)})
            }
        }
        if (capability && !skillMatch) {
            logger.debug('[SessionHandoffTool] capability 未匹配到技能，按普通会话交接', {capability})
        }
        const firstMessageContent = skillMatch
            ? `/${skillMatch.name}\n${args.handoffSummary}`
            : args.handoffSummary
        const commandId: string | undefined = skillMatch?.commandId
        // 附件 → 双用途构建（共享函数，与 execution.ts 跨 turn 历史重建同源，
        // 保证首轮直传与第二轮重建输出逐字节一致 → KV cache 前缀不断裂）：
        // 1) 落库：content 保持纯文本；metadata.attachments 结构化存储 → MessageList 附件卡片渲染
        // 2) 首轮：session_handoff_start 消息 content 用 buildUserHistoryContent 构建（图片 base64 块）
        const rawAttachments = (args.attachments || []).filter(a => a.path?.trim())
        const startContent = await buildUserHistoryContent(firstMessageContent, rawAttachments)

        // ★ 落库消息经唯一构建者 buildUserMessage（R5：预置 userMsgId——
        //   requestHandoffStart 依赖同一 id；附件单形态：顶层 attachments，metadata 仅 commandId）
        const {buildUserMessage} = await import('../../messageBuilder')
        const userMsg = await buildUserMessage({
            convId: newConvId,
            id: userMsgId,
            text: firstMessageContent,
            attachments: rawAttachments,
            metadata: commandId ? {commandId} : undefined,
        })
        if (!conversationRepo.writeMessages(newConvId, [userMsg])) {
            return {success: false, output: '', error: '写入交接总结失败'}
        }

        // ⑤ 通知渲染进程：侧栏新增会话 + 自动切换 activeConversationId（携带来源会话，供「←前会话」导航）
        notifySessionCreated(newConvId, args.title, workspacePath, parentConvId || undefined)

        // ⑥ 通知主进程为新会话启动独立 Agent Worker（交接首轮运行）
        //    工具立即返回，不等待首轮完成；新会话的运行由 AgentManager 管理，
        //    模型配置由主进程从 runtimeConfigManager 组装（含 API key 的完整方案）。
        //    首轮消息 content 为附件多模态构建版（与后续跨 turn 历史重建同源）
        const startRequested = requestHandoffStart(
            newConvId,
            args.title,
            {...userMsg, content: startContent},
            workspacePath,
        )

        logger.info('[SessionHandoffTool]', {
            action: 'handoffCreated',
            newConvId,
            parentConvId: parentConvId || '(none)',
            title: args.title,
            autoStart: startRequested,
        })

        return {
            success: true,
            output: `新会话『${args.title}』已创建，交接总结已注入，Agent 已自动启动继续工作。`
                + (capability && !skillMatch ? `\n（capability '${capability}' 未匹配到技能，已按普通会话创建。）` : '')
                + (startRequested ? '' : '\n（自动启动未成功，可切换到新会话手动发送消息继续）'),
        }
    },
}

/** 通用双路径发送：Worker → parentPort → 主进程；主进程直接 IPC */
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
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- sessionHandoffTool 运行在 MCP Worker 上下文，顶层 import window.ts 会把 electron 拉进 worker bundle
        const {getMainWindow} = require('../../../window')
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
            win.webContents.send(mainChannel, mainPayload)
        }
    } catch (err) {
        // window not available —— 通知失败不应影响工具结果，但须留痕排查（渲染端将感知不到会话切换）
        logger.warn(`[sessionHandoffTool] sendToRenderer 主进程路径失败 (channel=${mainChannel}): ${err instanceof Error ? err.message : String(err)}`)
    }
}

/** 通知渲染进程新增独立会话（自动切换；handoffFromConvId 供 MessageList「←前会话」导航） */
function notifySessionCreated(convId: string, title: string, workspacePath: string, handoffFromConvId?: string): void {
    sendToRenderer(
        'session_created',
        {convId, title, workspacePath, handoffFromConvId},
        'session_created',
        {id: convId, title, workspacePath, handoffFromConvId},
    )
}

/**
 * 通知主进程为新会话启动独立 Agent Worker（交接首轮运行）。
 * 主进程 AgentManager.start 负责创建 Worker 并组装模型方案（schemeConfig）。
 * 返回是否成功发出请求（Worker 是否实际启动由主进程异步决定）。
 */
function requestHandoffStart(convId: string, title: string, message: ChatMessage, workingDir: string): boolean {
    const payload = {
        convId,
        title,
        messages: [message],
        workingDir,
    }
    try {
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage({type: 'session_handoff_start', ...payload})
            return true
        }
    } catch (err) {
        logger.error('[SessionHandoffTool]', {action: 'requestHandoffStartError', convId, error: String(err)})
    }
    logger.error('[SessionHandoffTool]', {action: 'requestHandoffStartNotInWorker', convId})
    return false
}
