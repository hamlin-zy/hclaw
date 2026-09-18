/**
 * 项目组渲染层 store（spec §4.3「渲染端组数据落点」）。
 *
 * 定位：抽屉、会话列表分段、备忘录级联下拉、会话管理筛选的**共同数据源**。
 *  `viewScope` 只存组 id、不缓存组对象快照 → 组重命名/解散后界面不会显示过期组名
 *  （本 store 是所有组对象的唯一持有者，更新即刻广播给所有订阅者）。
 *
 * 写操作统一为「乐观更新 → 调 IPC → 失败回滚 + load() 对账」：
 * 拖拽是高频交互，等一次 IPC 往返再动会有明显粘滞感（spec §6.3）。
 */
import {create} from 'zustand'
import type {ProjectGroup, ProjectGroupWithMembers} from '@shared/types/projectGroup'

interface ProjectGroupState {
    groups: ProjectGroupWithMembers[]
    loading: boolean
    error: string | null
    load: () => Promise<void>
    create: (name: string) => Promise<string | null>
    rename: (id: string, name: string) => Promise<void>
    dissolve: (id: string) => Promise<void>
    remove: (id: string) => Promise<void>
    assign: (projectPath: string, groupId: string | null) => Promise<void>
    reorderGroups: (groupIds: string[]) => Promise<void>
    reorderProjects: (groupId: string, projectPaths: string[]) => Promise<void>
}

/** 归属推导（纯函数）：某项目属于哪个组；未分组返回 null */
export function projectGroupOf(
    groups: ProjectGroupWithMembers[],
    projectPath: string,
): ProjectGroup | null {
    return groups.find(g => g.members.some(m => m.projectPath === projectPath)) ?? null
}

/** IPC 桥是否就绪由调用方守卫：preload 未注入时各方法按原语义提前返回 */
const getApi = () => window.electronAPI?.projectGroup

/** 乐观更新包装：先改本地，再调 IPC；失败回滚快照并 load() 对账 */
async function optimistic<T>(
    set: (partial: Partial<ProjectGroupState>) => void,
    get: () => ProjectGroupState,
    patch: (groups: ProjectGroupWithMembers[]) => ProjectGroupWithMembers[],
    call: () => Promise<T>,
    isOk: (result: T) => boolean = (r) => r === true,
): Promise<void> {
    const snapshot = get().groups
    set({groups: patch(snapshot), error: null})
    let result: T
    try {
        result = await call()
    } catch (err) {
        set({groups: snapshot})
        await get().load() // 兜底对账：先回滚快照，再以服务端为准
        set({error: String(err)}) // 对账成功也不吞掉失败原因
        return
    }
    if (!isOk(result)) {
        set({groups: snapshot})
        await get().load()
        set({error: '项目组操作失败'})
        return
    }
    await get().load() // 成功也对账一次：服务端才是真源
}

export const useProjectGroupStore = create<ProjectGroupState>((set, get) => ({
    groups: [],
    loading: false,
    error: null,

    load: async () => {
        const api = getApi()
        if (!api) return
        set({loading: true})
        try {
            const groups = await api.list()
            set({groups: Array.isArray(groups) ? groups : [], error: null})
        } catch (err) {
            set({error: String(err)})
        } finally {
            set({loading: false})
        }
    },

    create: async (name) => {
        const api = getApi()
        if (!api) return null
        const res = await api.create(name)
        if (!res?.ok) {
            set({error: res?.error || '创建项目组失败'})
            return null
        }
        await get().load()
        return res.id
    },

    rename: async (id, name) => {
        const api = getApi()
        if (!api) return
        await optimistic(
            set, get,
            (groups) => groups.map(g => (g.id === id ? {...g, name} : g)),
            () => api.rename(id, name),
        )
    },

    dissolve: async (id) => {
        const api = getApi()
        if (!api) return
        // 解散：成员回顶层（同时清掉这些项目的 groupOrder）
        await optimistic(
            set, get,
            (groups) => groups.filter(g => g.id !== id),
            () => api.dissolve(id),
        )
    },

    remove: async (id) => {
        const api = getApi()
        if (!api) return
        await optimistic(
            set, get,
            (groups) => groups.filter(g => g.id !== id),
            () => api.remove(id),
        )
    },

    assign: async (projectPath, groupId) => {
        const api = getApi()
        if (!api) return
        // 先从所有组里摘掉该项目，再按目标组追加到末尾（服务端同语义）
        const patch = (groups: ProjectGroupWithMembers[]) => {
            const stripped = groups.map(g => ({
                ...g,
                members: g.members
                    .filter(m => m.projectPath !== projectPath)
                    .map((m, i) => ({...m, groupOrder: i})),
            }))
            if (groupId === null) return stripped
            return stripped.map(g => (g.id === groupId
                ? {...g, members: [...g.members, {projectPath, groupOrder: g.members.length}]}
                : g))
        }
        await optimistic(set, get, patch, () => api.assign(projectPath, groupId))
    },

    reorderGroups: async (groupIds) => {
        const api = getApi()
        if (!api) return
        const patch = (groups: ProjectGroupWithMembers[]) =>
            groupIds
                .map((id, i) => {
                    const g = groups.find(x => x.id === id)
                    return g ? {...g, sortOrder: i} : null
                })
                .filter((g): g is ProjectGroupWithMembers => g !== null)
        await optimistic(set, get, patch, () => api.reorderGroups(groupIds))
    },

    reorderProjects: async (groupId, projectPaths) => {
        const api = getApi()
        if (!api) return
        const patch = (groups: ProjectGroupWithMembers[]) => groups.map(g => {
            if (g.id !== groupId) return g
            const byPath = new Map(g.members.map(m => [m.projectPath, m]))
            return {
                ...g,
                members: projectPaths.map((p, i) => ({projectPath: p, groupOrder: i}))
                    .filter(m => byPath.has(m.projectPath)),
            }
        })
        await optimistic(set, get, patch, () => api.reorderProjects(groupId, projectPaths))
    },
}))
