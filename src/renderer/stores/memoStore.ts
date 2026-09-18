/**
 * 备忘录渲染层 zustand store（Task 5）
 *
 * - 所有 IPC 返回包装 {ok:true,data} | {ok:false,error}，此处统一解包
 * - 低频操作：create/updateItem/remove 成功后全量刷新（load）
 * - createSession 失败仅置 error 并返回 null，不 throw 出 store 边界
 * - loadForScope：按视图作用域（组视图 = 组内所有项目）并行取数 + 作用域级竞态守卫，
 *   与单项目 load 的 activeWorkspacePath 守卫并存、互不干扰（Task 18）
 * - subscribeMemoChangedForScope：memo_changed 推送的项目**属于当前作用域**才 reload，
 *   由 MemoPanel 挂载时调用一次（Task 8 / Task 18 扩作用域）
 */
import {create} from 'zustand'
import type {MemoItem, MemoAttachment, MemoCapability, MemoPriority} from '@shared/types/memo'
import {useConversationStore} from './conversationStore'
import {useProjectGroupStore} from './projectGroupStore'

interface MemoStoreState {
    memos: MemoItem[]
    loading: boolean
    error: string | null
    load: (workspacePath: string) => Promise<void>
    /**
     * 按视图作用域取数（Task 18）：并行 `memo.list(path)` → 按 `MemoItem.id` 合并。
     * `scopeKey` 仅用于作用域级竞态守卫（口径见 MemoPanel：`group:<id>` / `project:<path>`）。
     */
    loadForScope: (projectPaths: string[], scopeKey: string) => Promise<void>
    /** 订阅 memo_changed：推送的项目属于当前作用域时调用 `reload`，返回退订函数 */
    subscribeMemoChangedForScope: (getProjectPaths: () => string[], reload: () => void) => () => void
    create: (input: {workspacePath: string; title: string; content: string; capability?: MemoCapability; attachments?: MemoAttachment[]; priority?: MemoPriority}) => Promise<MemoItem | null>
    updateItem: (id: string, patch: Partial<MemoItem>) => Promise<void>
    remove: (id: string) => Promise<void>
    removeMany: (ids: string[]) => Promise<void>
    createSession: (id: string) => Promise<{convId: string} | null>
}

const unwrap = <T,>(res?: {ok: boolean; data?: T; error?: string}): T | null => {
    if (res && res.ok) return res.data ?? null
    return null
}

/** 最近一次 load 请求的工作区（竞态守卫基准，见 load 内注释） */
let activeWorkspacePath = ''

/**
 * 最近一次**作用域**取数请求的 key（作用域级竞态守卫基准）。
 * ★ 与 activeWorkspacePath 并存且互不干扰：load / loadForScope 各自只认自己的守卫，
 *   组视图切作用域时旧批次整批丢弃，不会污染单项目 load 的结果。
 */
let activeScopeKey = ''

/**
 * 最近一次生效的**作用域**（用于条目变更后的刷新决策，Task 18 fix）：
 * 组视图变更条目 → 仍按整组合并刷新；单项目 / 空作用域 → 回落单项目 load。
 * - loadForScope 提交结果时写入（成功/失败路径均写，空作用域置 null）
 * - load（单项目路径）置 null
 * ★ 不对外暴露：仅本模块内部使用，不进 state、不进接口类型。
 */
let activeScope: {key: string; paths: string[]} | null = null

/**
 * 打开新建备忘录编辑窗口（MemoPanel 新建按钮与 Ctrl+Shift+N 快捷键共用）。
 *
 * 默认项目解析的**唯一落点**（Task 19 R-CA）：两个入口都只负责传「回退值」，
 * 组视图下解析「组内最近活跃会话所属项目」（§15.1②），其余情况用回退值；
 * 最终仍为空 → 不打开窗口（守卫集中在此，入口无需各自判断）。
 */
export function openMemoCreateWindow(workspacePath: string) {
    const target = resolveMemoProjectForScope(workspacePath)
    if (!target) return
    void window.electronAPI?.openConfigWindow?.('memo-edit', [`--hclaw-memo-workspace=${encodeURIComponent(target)}`])
}

/**
 * 新建窗口默认项目解析（§15.1② + R-BZ/R-CA）：
 * - 组视图且组存在 → 该组内「最近活跃过」的会话所属项目
 *   （口径 = 各成员项目会话 `updatedAt` 最大值，与列表排序用的 `createdAt` 明确区分；
 *    平手取组成员顺序靠前者）
 * - 组视图但组不存在 / 组内无任何会话 → 回退传入值
 * - 非组视图（单项目 / 无作用域）→ 传入值
 * ★ 与 Task 18 的 `loadForScope/activeScope` 无关：这里只读 conversationStore /
 *   projectGroupStore 的快照，不读写本模块的作用域取数状态。
 */
function resolveMemoProjectForScope(fallback: string): string {
    const {viewScope, workspaces} = useConversationStore.getState()
    if (viewScope?.type !== 'group') return fallback
    const group = useProjectGroupStore.getState().groups.find((g) => g.id === viewScope.groupId)
    if (!group) return fallback
    let best = ''
    let bestAt = -1
    for (const {projectPath} of group.members) {
        for (const conv of workspaces[projectPath]?.conversations ?? []) {
            const at = conv.updatedAt ?? 0
            if (at > bestAt) {
                bestAt = at
                best = projectPath
            }
        }
    }
    return best || fallback
}

export const useMemoStore = create<MemoStoreState>((set, get) => ({
    memos: [],
    loading: false,
    error: null,

    load: async (workspacePath: string) => {
        // 单项目路径：清空作用域标记，变更后回落单项目刷新
        activeScope = null
        // ★ 竞态守卫：本 store 不持有「当前工作区」状态字段（memos 仅存条目、各自带
        //   workspacePath），故用模块级变量记录最近一次请求的工作区。await 回来后若
        //   已被更新的工作区请求取代，则丢弃过期响应（旧工作区数据不得覆盖新工作区）。
        activeWorkspacePath = workspacePath
        set({loading: true})
        try {
            const res = await window.electronAPI?.memo.list(workspacePath)
            if (activeWorkspacePath !== workspacePath) return // 工作区已切换：丢弃
            const data = unwrap<MemoItem[]>(res)
            if (data) {
                set({memos: data, error: null})
            } else {
                set({memos: [], error: res?.error || '加载备忘录失败'})
            }
        } finally {
            if (activeWorkspacePath === workspacePath) set({loading: false})
        }
    },

    loadForScope: async (projectPaths: string[], scopeKey: string) => {
        activeScopeKey = scopeKey
        if (projectPaths.length === 0) {
            activeScope = null
            set({memos: [], loading: false, error: null})
            return
        }
        set({loading: true})
        try {
            const results = await Promise.all(
                projectPaths.map(async (p) => {
                    try { return await window.electronAPI?.memo.list(p) } catch { return null }
                }),
            )
            if (activeScopeKey !== scopeKey) return // 作用域已切换：整批丢弃
            // 作用域已生效：记录之（成功 / 部分失败路径都写，变更后按整组刷新）
            activeScope = {key: scopeKey, paths: projectPaths}
            const merged = new Map<string, MemoItem>()
            let failed = 0
            for (const res of results) {
                if (!res?.ok || !res.data) { failed++; continue }
                for (const item of res.data as MemoItem[]) merged.set(item.id, item)
            }
            set({memos: Array.from(merged.values()), error: failed > 0 ? '部分项目备忘录加载失败' : null})
        } finally {
            if (activeScopeKey === scopeKey) set({loading: false})
        }
    },

    subscribeMemoChangedForScope: (getProjectPaths, reload) =>
        window.electronAPI?.onMemoChanged(({workspacePath}) => {
            if (getProjectPaths().includes(workspacePath)) reload()
        }) ?? (() => {}),

    create: async (input) => {
        const res = await window.electronAPI?.memo.create(input)
        const data = unwrap<MemoItem>(res)
        if (data) {
            await refreshAfterMutation(input.workspacePath)
            return data
        }
        set({error: res?.error || '创建备忘录失败'})
        return null
    },

    updateItem: async (id: string, patch: Partial<MemoItem>) => {
        const res = await window.electronAPI?.memo.update(id, patch)
        if (!unwrap(res)) {
            set({error: res?.error || '更新备忘录失败'})
            return
        }
        const current = get().memos.find((m) => m.id === id)
        await refreshAfterMutation(current?.workspacePath ?? (patch as {workspacePath?: string}).workspacePath ?? '')
    },

    remove: async (id: string) => {
        const current = get().memos.find((m) => m.id === id)
        const res = await window.electronAPI?.memo.remove(id)
        if (!unwrap(res)) {
            set({error: res?.error || '删除备忘录失败'})
            return
        }
        if (current) await refreshAfterMutation(current.workspacePath)
    },

    /** 批量删除（删除组内备忘录）：一次 IPC + 一次全量刷新 */
    removeMany: async (ids) => {
        if (ids.length === 0) return
        const current = get().memos.find((m) => ids.includes(m.id))
        const res = await window.electronAPI?.memo.removeMany(ids)
        if (!unwrap(res)) {
            set({error: res?.error || '批量删除备忘录失败'})
            return
        }
        if (current) await refreshAfterMutation(current.workspacePath)
    },

    createSession: async (id: string) => {
        const res = await window.electronAPI?.memo.createSession(id)
        const data = unwrap<{convId: string}>(res)
        if (data) {
            set({error: null})
            return data
        }
        set({error: res?.error || '创建会话失败'})
        return null
    },
}))

/**
 * 条目变更（create/updateItem/remove/removeMany）成功后的刷新入口（Task 18 fix）：
 * - 变更项目属于当前作用域 → 重新按整组作用域取数（保持多项目合并，避免组视图塌缩）
 * - 否则 → 既有单项目 `load(workspacePath)`（单项目视图行为逐字不变）
 */
function refreshAfterMutation(workspacePath: string): Promise<void> {
    const scope = activeScope
    if (scope && scope.paths.includes(workspacePath)) {
        return useMemoStore.getState().loadForScope(scope.paths, scope.key)
    }
    return useMemoStore.getState().load(workspacePath)
}
