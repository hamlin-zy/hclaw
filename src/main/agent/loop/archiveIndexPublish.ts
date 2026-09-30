/**
 * 归档卷索引 pre-step（追加式，与 catalog/env/memory/languageGuard 四个 pre-step 同构）
 *
 * 在 agent 主循环"构建系统提示词"之前调用：
 * - buildArchiveIndex 扫描归档目录、产出索引正文与 digest（索引本身不落盘）
 * - 仅在 digest 变化（或尚未发布）时追加一条新的 user 角色索引消息
 * - 持久化走 conversationRepository.writeMessagesDelta（与 memoryPublish 相同模式）
 *
 * 缓存安全铁律：
 * - 只追加不改：无 update-by-id、无 tombstone（与 catalogPublish 同铁律）；
 * - **注入只允许发生在每个 run 的首次迭代** —— 门禁在 controller 侧（本模块只认"调用"
 *   这一事实，不做任何轮次判断），
 *   本函数**不做** iteration 判断。原因与语言守卫相同：DB 层"一次用户发言 = 一条
 *   assistant 行"，run 内内存态"一次 LLM 调用 = 一条 assistant 消息"；在 iteration ≥2
 *   追加会让重建序列在注入点分叉（[u,a1,t1,INJ,a2] vs [u,apply(...),INJ]），
 *   注入点之后的前缀缓存全失效。
 *
 * 状态随注入消息自己的 metadata 走（零新增存储）：MemoryState.lastArchiveIndexDigest
 * 仅做门控与崩溃恢复；消息追加后不再改动。sourceKind 复用 'memory'（不新增类别），
 * 靠 ARCHIVE_INDEX_DIGEST_KEY 与记忆消息区分。
 *
 * 整个 pre-step 包裹在 try-catch 内：索引注入失败绝不阻断主循环。
 */

import {randomUUID} from 'crypto'
import type {ChatMessage, LoopState} from '../state'
import {addMessage} from '../state'
import type {IConversationRepository} from '../../repositories/interfaces'
import type {Message} from '@shared/types'
import {MEMORY_SOURCE_KIND, ARCHIVE_INDEX_DIGEST_KEY} from '@shared/types/memory'
import type {MemoryState} from '@shared/types/memory'
import {buildArchiveIndex} from '../memory/archiveIndex'
import type {ArchiveIndexLimits} from '../memory/archiveIndex'
import {logger} from '../logger'

export type {MemoryState}

/** 索引正文标题行（第②段首行） */
const INDEX_TITLE_LINE = '# 长期记忆索引（按需读取）'

/** 指引行（第④段）：**必须在 <system-reminder> 包裹之内**，否则索引消息会渲染成用户气泡 */
const INDEX_GUIDE_LINE =
    '任务涉及上述主题时，用 file_read 读取对应卷全文后再动手；清单只是地图，不要凭卷名臆断内容。'

/**
 * 装配索引注入正文（固定五段，spec 注入窗口约束）：
 * ① 起始标签行 ② 标题行 + 空行 + {body} ③ 空行 ④ 指引行 ⑤ 结束标签行。
 *
 * `body` 末尾换行在此归一 —— 硬截断路径下 body 不以 `\n` 收尾，直接拼接会让第③段空行
 * 消失（本次归一后两种收尾形态的段结构一致）。
 */
export function renderArchiveIndexContent(body: string): string {
    const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body
    return `<system-reminder>\n${INDEX_TITLE_LINE}\n\n${trimmed}\n\n${INDEX_GUIDE_LINE}\n</system-reminder>`
}

/**
 * 执行归档卷索引 pre-step。
 *
 * 调用方（controller）必须只在每个 run 的首次迭代调用本函数（§3.2 硬约束 / R16）。
 *
 * @param options.hclawDir HClaw 配置目录
 * @param options.workspacePath 会话工作目录（用于定位项目级归档卷）
 * @param options.memoryEnabled 用户习惯记忆功能总开关（关闭时索引一并关闭）
 * @param options.channel 渠道标识；schedule 会话（系统定时任务）不注入索引
 * @param options.limits 索引预算（缺省由构建器回落 ARCHIVE_INDEX_DEFAULTS）
 * @returns 更新后的 LoopState 与 MemoryState（无需注入时原样返回入参引用）
 */
export function runArchiveIndexPreStep(
    currentState: LoopState,
    indexState: MemoryState,
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    options: {
        hclawDir: string
        workspacePath: string | null
        memoryEnabled: boolean
        channel?: string
        limits?: Partial<ArchiveIndexLimits>
    },
): {state: LoopState; memoryState: MemoryState} {
    const {hclawDir, workspacePath, memoryEnabled, channel, limits} = options
    /** 跳过本轮的统一返回体：state 与 memoryState 均原样返回（零副作用，保持引用相等） */
    const unchanged = {state: currentState, memoryState: indexState}

    try {
        if (!memoryEnabled) return unchanged
        if (channel === 'schedule') return unchanged

        const index = buildArchiveIndex({hclawDir, workspacePath, limits})
        if (!index) return unchanged
        if (index.digest === indexState.lastArchiveIndexDigest) return unchanged

        const created: ChatMessage = {
            id: randomUUID(),
            role: 'user',
            content: renderArchiveIndexContent(index.body),
            metadata: {
                sourceKind: MEMORY_SOURCE_KIND,
                [ARCHIVE_INDEX_DIGEST_KEY]: index.digest,
            } as Record<string, unknown>,
        }
        persist(conversationRepo, sessionId, created)

        logger.info('[AgentLoop] archive index pre-step published', {
            messageId: created.id!.slice(0, 8),
            truncated: index.truncated,
        })
        return {
            state: addMessage(currentState, created),
            memoryState: {...indexState, lastArchiveIndexDigest: index.digest},
        }
    } catch (err) {
        // 索引注入失败不阻断主循环
        logger.debug('[AgentLoop] archive index pre-step skipped', {error: String(err)})
        return unchanged
    }
}

/** 落库（sessionId 空时仅内存态） */
function persist(
    conversationRepo: IConversationRepository | null,
    sessionId: string | undefined,
    message: ChatMessage,
): void {
    if (!conversationRepo || !sessionId) {
        logger.debug('[AgentLoop] no session, archive index message kept in memory only')
        return
    }
    try {
        // ChatMessage 无 timestamp 字段；落库 Message 需要，此处补齐（与 memoryPublish 同款）
        conversationRepo.writeMessagesDelta(sessionId, {...message, timestamp: Date.now()} as unknown as Message)
    } catch (err) {
        logger.debug('[AgentLoop] archive index message persist failed', {error: String(err)})
    }
}
