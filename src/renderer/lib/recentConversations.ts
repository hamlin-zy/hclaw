/**
 * 组视图「最近会话」跨项目列表构造（纯函数）。
 *
 * ★ 口径说明（与 spec §7.2 的关系）：§7.2 的 createdAt 规则约束的是**段内列表**
 *   （置顶优先 → createdAt desc）；本列表是跨项目的「最近使用」混排，语义就是
 *   updatedAt desc —— 这是组视图双区结构的新决策，**不是**对 §7.2 的修改。
 *
 * 数据范围由调用方决定（当前约定 = 组内成员项目的会话，spec §16 追加）；
 * 只消费启动时已全量在内存的 ConversationSummary 摘要，不做任何消息预热（§10.2-1）。
 */
import type {ConversationSummary} from '@shared/types/infra'

export interface RecentConversation {
    conv: ConversationSummary
    workspacePath: string
}

/**
 * 按 updatedAt desc 取前 N（默认 10）条；updatedAt 相同的保持入参次序（稳定排序）。
 * 单个项目 conversations 为空或入参全空 → 返回 []（调用方整块不渲染）。
 *
 * ★ 只取根会话：parentConvId 非空且父会话就在同一项目集合内的子会话不进本列表 ——
 *   子会话在段区是挂在父会话下的树状节点，混进扁平的"快速跳转"列表既缺父上下文、
 *   又与段区重复展示；孤儿（父会话已不在集合内）沿用仓库"孤儿算根"口径（infra.ts
 *   根会话数注释）照常入选。
 */
export function buildRecentConversations(
    entries: Array<{workspacePath: string; conversations: ConversationSummary[]}>,
    limit = 10,
): RecentConversation[] {
    const all: RecentConversation[] = []
    for (const entry of entries) {
        const ids = new Set((entry.conversations ?? []).map((c) => c.id))
        for (const conv of entry.conversations ?? []) {
            // 父会话不在本项目集合内 = 孤儿子会话，视为根（与段区树状渲染的可见性一致）
            if (conv.parentConvId && ids.has(conv.parentConvId)) continue
            all.push({conv, workspacePath: entry.workspacePath})
        }
    }
    // 稳定排序：Array.prototype.sort 在现代引擎均稳定，同 updatedAt 保持入参（项目段）次序
    return all
        .sort((a, b) => (b.conv.updatedAt ?? 0) - (a.conv.updatedAt ?? 0))
        .slice(0, limit)
}
