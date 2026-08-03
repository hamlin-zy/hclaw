/**
 * 会话树工具函数
 *
 * 与渲染 store 解耦的纯函数模块，供 conversationStore 的级联删除
 * 与弹窗文案的子会话数统计复用，可独立单元测试。
 */
import type {ConversationSummary} from '@shared/types'

/**
 * 收集 ids 的所有后代子会话 ID（含间接后代），返回并集（去重、包含 ids 本身）。
 * 通过 parentConvId 建立父→子映射后 BFS 遍历。
 */
export function collectDescendants(
    conversations: ConversationSummary[],
    ids: string[],
): string[] {
    const byParent = new Map<string, string[]>()
    for (const c of conversations) {
        if (c.parentConvId) {
            const list = byParent.get(c.parentConvId) ?? []
            list.push(c.id)
            byParent.set(c.parentConvId, list)
        }
    }
    const result = new Set(ids)
    const queue = [...ids]
    while (queue.length) {
        const parent = queue.shift()!
        for (const child of byParent.get(parent) ?? []) {
            if (!result.has(child)) {
                result.add(child)
                queue.push(child)
            }
        }
    }
    return [...result]
}
