/**
 * 会话列表分段构造（纯函数）。
 *
 * 单项目视图与组视图**共用这一份代码**（spec D13/§7.4：不新增第二套排序），
 * 差别只在入参：单视图传 1 个项目 + singleProject=true。
 *
 * 口径钉死（spec §7.2）：
 *  - 排序 = 置顶优先 → createdAt desc（**不是** updatedAt desc）
 *  - 窗口 = 全部置顶（豁免截断）+ 最近 visibleCount（默认 SECTION_DEFAULT）条非置顶根会话；
 *    当前激活会话及其祖先链亦豁免截断（spec §5.2.4 / V11 / F16）
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
    /** 是否还有被窗口截掉的非置顶根会话（分页控制条据此决定 ∨∨ 是否渲染） */
    hasMore: boolean
    /** 可翻页上限：该段根会话总数（搜索/非搜索都适用；分页控制条 total 入参） */
    totalRoots: number
    /** 已按「置顶优先 → createdAt desc」排好序、且按父子关系展开成行 */
    rows: SectionRow[]
}

/** 段内行：普通会话行（含子会话窗口大小） */
export type SectionRow =
    | {kind: 'conv'; id: string; parentConvId?: string; indentLevel: number; childCount: number; childShownCount?: number}

/** 窗口默认值与步长（spec §5.4）：单一出口，禁散落硬编码 */
export const SECTION_DEFAULT = 6
export const SECTION_STEP = 10
export const CHILD_DEFAULT = 3
export const CHILD_STEP = 3
export const RECENT_DEFAULT = 10
export const RECENT_STEP = 10

export function buildConversationSections(input: {
    projects: SectionInput[]
    searchQuery: string
    collapsedKeys: string[]
    /** 单项目视图 = true（无 chevron、不提供折叠） */
    singleProject?: boolean
    windowSize?: number
    /**
     * 【已失效，待清理】Task 12 后本函数内部使用 `searching` 决定子列表是否全量展示，
     * 本入参在函数体内已无任何消费点；保留仅为最小变更，让 store 侧调用点无需同步删参。
     * 后续清理时与 store 侧同批移除。
     * 原语义：已被用户点「加载更多」整体展开子列表的父会话 id 集合（会话级，不持久化）。
     */
    expandedChildParents?: Record<string, true>
    /** 子会话窗口大小（父会话 id → 可见条数；缺省 CHILD_DEFAULT） */
    childWindowSizes?: Record<string, number>
    /**
     * 当前激活会话 id：**豁免窗口截断**（spec §5.2.4 / V11 / F16）。
     * 场景：从「最近会话」点开一条按 createdAt 排位很老、落在窗口外的会话时，
     * 它必须可见（含它作为子会话时被截断的父行），否则侧栏里看不到当前所在会话。
     * 豁免只扩大可见集合：不改窗口大小、不改排序口径、不改 hasMore 基数。
     */
    activeConversationId?: string
}): ConversationSection[] {
    const {projects, searchQuery, collapsedKeys, singleProject = false, childWindowSizes, activeConversationId} = input
    const windowSize = input.windowSize ?? SECTION_DEFAULT
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
        // ★ 激活会话祖先链：沿 parentConvId 上溯整条链（含激活项自身）。
        //   深度 ≥2 时祖父可能被根窗口截断、中间层可能被子窗口截断，豁免只补一跳
        //   会让祖先链任一环截断都导致激活行整体不在 DOM（spec §5.2.4 / V11 / F16）。
        //   Set 记录已访问 id：链上成环时遇到重复即停，保证循环必然终止。
        const activeAncestryIds = new Set<string>()
        if (activeConversationId) {
            const byId = new Map(all.map(c => [c.id, c]))
            let cur: string | undefined = activeConversationId
            while (cur && idSet.has(cur) && !activeAncestryIds.has(cur)) {
                activeAncestryIds.add(cur)
                cur = byId.get(cur)?.parentConvId
            }
        }
        // 搜索命中时忽略窗口（spec §7.2）
        // ★ 窗口截断豁免（spec §5.2.4 / V11 / F16）：置顶本就豁免截断（既有行为），
        //   本处新增「∪ 当前激活会话及其祖先链」。被截掉的激活会话若不可见，用户从
        //   「最近会话」点开它后侧栏里就没有当前所在项（老会话恰好落在窗口外）。
        const windowedUnpinned = searching
            ? unpinnedRoots
            : (() => {
                const inWindow = unpinnedRoots.slice(0, windowOf(p))
                if (!activeConversationId || inWindow.some(c => c.id === activeConversationId)) return inWindow
                // 激活项自身 + 沿 parentConvId 上溯的整条祖先链一并豁免。
                // 只收「非置顶根会话」：置顶根本就在集合内，子会话由下方子列表窗口豁免。
                // 已 inWindow 的要去掉 —— 父常常本就在窗口内，重复追加会渲染出重复行（React key 冲突）。
                // unpinnedRoots 与 all 的元素是同一批对象引用（filter/sort 不改引用），故 includes 成立。
                const exempt = all.filter(c =>
                    activeAncestryIds.has(c.id) && !c.pinned && !inWindow.includes(c) && unpinnedRoots.includes(c))
                if (exempt.length === 0) return inWindow
                // 豁免行按既有排序口径回到原位置（与「置顶优先 → createdAt desc」一致）
                return [...inWindow, ...exempt].sort(compareConversations)
            })()
        const visibleRoots = [...pinnedRoots, ...windowedUnpinned]
        // ★ hasMore 基数 = 非置顶根会话总数 vs 段窗口大小，与「豁免进来的行数」无关：
        //   豁免项本就在窗口之外，若拿 windowedUnpinned.length 当基数，豁免会把 hasMore
        //   误压成 false（明明还有更多却不再显示「···」）。搜索态恒 false（忽略窗口）。
        const hasMore = !searching && unpinnedRoots.length > windowOf(p)

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
            // 子会话窗口：默认只显示前 CHILD_DEFAULT 条（最新的在前），用户可经
            // 子级 PagerBar 调整窗口大小（childWindowSizes）。搜索态豁免窗口（与根
            // 会话窗口口径一致，spec §7.2）。
            const windowed = children.slice(0, childWindowSizes?.[conv.id] ?? CHILD_DEFAULT)
            // ★ 窗口截断豁免（spec §5.2.4 / V11 / F16）：激活的子会话、以及激活会话
            //   任一祖先（中间层）即使排在各自子窗口之外也要可见 —— 中间层被截会让
            //   激活行整条分支不在 DOM。
            //   只追加不遮挡：无豁免时 `[...windowed]` 与 `windowed` 逐行等价。
            const exemptChildren = children.filter(c => activeAncestryIds.has(c.id) && !windowed.includes(c))
            const visible = searching
                ? children
                : exemptChildren.length === 0
                    ? windowed
                    : [...windowed, ...exemptChildren].sort(compareConversations)
            // ★ childShownCount = 实际可见子会话数（PagerBar count 入参）
            rows[rows.length - 1].childShownCount = visible.length
            for (const child of visible) pushWithChildren(child, indentLevel + 1)
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
            totalRoots: roots.length,
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
