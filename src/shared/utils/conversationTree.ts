/**
 * 会话树工具函数（shared 版）
 *
 * 供主进程用量聚合与渲染进程会话树复用，避免两处实现漂移。
 */
import type {ConversationSummary} from '../types'

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
