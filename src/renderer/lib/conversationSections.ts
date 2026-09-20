/**
 * 会话列表分段构造（纯函数）。
 *
 * 单项目视图与组视图**共用这一份代码**（spec D13/§7.4：不新增第二套排序），
 * 差别只在入参：单视图传 1 个项目 + singleProject=true。
 *
 * 口径钉死（spec §7.2）：
 *  - 排序 = 置顶优先 → createdAt desc（**不是** updatedAt desc）
 *  - 窗口 = 全部置顶（豁免截断）+ 最近 visibleCount（默认 10）条非置顶根会话
 *  - 计数单位 = 根会话；父被截断 → 子一并隐藏
 *  - 搜索命中忽略窗口；有命中的段强制展开（D19）
 *  - 折叠只影响渲染；「N 条」= 该项目下全量会话数（DB 口径，含子会话），
 *    不随窗口截断变化（窗口只影响 rows/hasMore）
 */
import type {ConversationSummary} from '@shared/types/infra'
import {fuzzyFilter} from './search'

export interface SectionInput {
    /** 段 key：组视图 = 项目路径；单项目视图 = 项目路径 */
    projectPath: string
    projectName: string
    gitBranch: string | null
    conversations: ConversationSummary[]
    /** 该段已加载的非置顶条数（窗口大小）；缺省 10 */
    visibleCount?: number
}

export interface ConversationSection {
    key: string
    projectPath: string
    projectName: string
    gitBranch: string | null
    /** 折叠态（仅影响渲染；计数按"展开后可见行数"给） */
    collapsed: boolean
    /** 该项目下全量会话数（含子会话；即使窗口截断也显示 DB 真实总数） */
    count: number
    /** 是否显示「加载更多」：还有被窗口截掉的非置顶根会话 */
    hasMore: boolean
    /** 已按「置顶优先 → createdAt desc」排好序、且按父子关系展开成行（含子会话「加载更多」占位行） */
    rows: SectionRow[]
}

/** 段内行：普通会话行，或某父会话子列表的「加载更多」占位行 */
export type SectionRow =
    | {kind: 'conv'; id: string; parentConvId?: string; indentLevel: number; childCount: number}
    | {kind: 'load-more'; /** 稳定 key；不会与真实会话 id 冲突（前缀命名空间） */ id: string; /** 触发展开的父会话 id；祖先链可见性检查与 conv 行同口径 */ parentConvId?: string; indentLevel: number; hiddenCount: number}

const DEFAULT_WINDOW_SIZE = 10
/** 每个父会话默认可见的子会话数（其余收进「加载更多」，一次展开全部剩余） */
export const CHILD_WINDOW_SIZE = 3

export function buildConversationSections(input: {
    projects: SectionInput[]
    searchQuery: string
    collapsedKeys: string[]
    /** 单项目视图 = true（无 chevron、不提供折叠） */
    singleProject?: boolean
    windowSize?: number
    /** 已被用户点「加载更多」整体展开子列表的父会话 id 集合（会话级，不持久化） */
    expandedChildParents?: Record<string, true>
}): ConversationSection[] {
    const {projects, searchQuery, collapsedKeys, singleProject = false, expandedChildParents} = input
    const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE
    const searching = searchQuery.trim().length > 0

    /** 段内窗口大小：`SectionInput.visibleCount`（该段已加载条数）优先，回退到全局 `windowSize` */
    const windowOf = (p: SectionInput) => p.visibleCount ?? windowSize

    return projects.map(p => {
        const all = p.conversations
        const idSet = new Set(all.map(c => c.id))
        const isRoot = (c: ConversationSummary) => !c.parentConvId || !idSet.has(c.parentConvId)

        const matched = searching ? fuzzyFilter(all, searchQuery, ['title', 'preview']) : all
        const matchedIds = new Set(matched.map(c => c.id))

        // ★ I-3：只命中子会话时，其父/祖先不在命中集合 → roots 为空 → 段虽被强制展开却
        //   渲染「暂无会话」，命中的子会话不可见。搜索态下把命中项的祖先链一并视为命中，
        //   使祖先根会话进入 visibleRoots，从而带出被命中的子会话。
        //   只扩大命中集合，不改窗口口径（搜索态仍忽略窗口）与 count/hasMore 公式。
        if (searching) {
            const byId = new Map(all.map(c => [c.id, c]))
            for (const c of matched) {
                let cur = c.parentConvId
                while (cur && idSet.has(cur) && !matchedIds.has(cur)) {
                    matchedIds.add(cur)
                    cur = byId.get(cur)?.parentConvId
                }
            }
        }

        const roots = all
            .filter(isRoot)
            .filter(c => (searching ? matchedIds.has(c.id) : true))
            .sort(compareConversations)

        const pinnedRoots = roots.filter(c => c.pinned)
        const unpinnedRoots = roots.filter(c => !c.pinned)
        // 搜索命中时忽略窗口（spec §7.2）
        const windowedUnpinned = searching ? unpinnedRoots : unpinnedRoots.slice(0, windowOf(p))
        const visibleRoots = [...pinnedRoots, ...windowedUnpinned]
        const hasMore = !searching && unpinnedRoots.length > windowedUnpinned.length

        // 子会话：仅当父在可见集合内才渲染；父被截断 → 子一并隐藏
        const childrenOf = new Map<string, ConversationSummary[]>()
        for (const c of all) {
            if (!c.parentConvId || !idSet.has(c.parentConvId)) continue
            const list = childrenOf.get(c.parentConvId) ?? []
            list.push(c)
            childrenOf.set(c.parentConvId, list)
        }

        const rows: ConversationSection['rows'] = []
        const pushWithChildren = (conv: ConversationSummary, indentLevel: number) => {
            const children = (childrenOf.get(conv.id) ?? []).slice().sort(compareConversations)
            rows.push({kind: 'conv', id: conv.id, parentConvId: conv.parentConvId, indentLevel, childCount: children.length})
            // 子会话窗口：默认只显示前 CHILD_WINDOW_SIZE 条（最新的在前），其余收进
            // 「加载更多」占位行（点击一次性展开全部剩余）。搜索态豁免窗口（与根会话
            // 窗口口径一致，spec §7.2）。
            const expandedAll = searching || !!expandedChildParents?.[conv.id]
            const visible = expandedAll ? children : children.slice(0, CHILD_WINDOW_SIZE)
            for (const child of visible) pushWithChildren(child, indentLevel + 1)
            if (!expandedAll && children.length > visible.length) {
                rows.push({
                    kind: 'load-more',
                    id: `load-more:${conv.id}`,
                    parentConvId: conv.id,
                    indentLevel: indentLevel + 1,
                    hiddenCount: children.length - visible.length,
                })
            }
        }
        for (const root of visibleRoots) {
            pushWithChildren(root, 0)
        }

        // ★ count = 项目下全量会话数（含子会话），即数据库真实总数；
        //   不用 visibleRoots.length（那是窗口内可见根会话数，会随「···」展开而变）
        const count = all.length
        // 单项目视图只有一个段 → 不提供 chevron，折叠集合不生效
        const forcedOpen = singleProject || (searching && matchedIds.size > 0)
        const collapsed = !forcedOpen && collapsedKeys.includes(p.projectPath)

        return {
            key: p.projectPath,
            projectPath: p.projectPath,
            projectName: p.projectName,
            gitBranch: p.gitBranch,
            collapsed,
            count,
            hasMore,
            rows: collapsed ? [] : rows,
        }
    })
}

/**
 * 「最近」= 置顶优先 → createdAt desc。
 * ⚠ 不使用 updatedAt（预热口径），否则会出现"刚用过但创建得早的会话被截掉"（spec §7.2）。
 * 不直接复用排序返回 boolean 的写法是为了让比较器可单独测试。
 */
function compareConversations(a: ConversationSummary, b: ConversationSummary): number {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return (b.createdAt || 0) - (a.createdAt || 0)
}
