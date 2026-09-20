import type {ProjectGroupWithMembers} from '@shared/types/projectGroup'
import type {ViewScope} from '../stores/conversationStore'
import {workspacePathKey} from './workspacePath'

/**
 * 「工作中…」运行中会话跳转的**视图跟随矩阵**（spec 口径，纯函数便于单测）：
 *
 * · stay           —— 目标在当前视图显示范围内：视图完全不动（除用户主动切换，任何功能不得强切视图）。
 * · group          —— 目标不在视图内但已入组：优先切到目标所属项目组视图并定位该段。
 * · project        —— 目标不在视图内且未入组：退化为单项目视图跟随（followScopeToProject）。
 * · activate-only  —— 未归属会话（无工作目录）：无组无路径可跟随，只激活会话、不动视图。
 *
 * 「是否在视图内」由调用方传入 `resolveScopeProjectPaths` 的结果（组视图成员 + 未归属段
 * 的统一口径），此处只做归一化键比较（workspacePathKey：尾分隔符 / 大小写等价串不误判）。
 */
export type RunningSessionJumpPlan =
    | {kind: 'stay'}
    | {kind: 'group'; groupId: string}
    | {kind: 'project'}
    | {kind: 'activate-only'}

export function resolveRunningSessionJumpPlan(args: {
    /** 当前视图取数口径下的可见项目路径集（conversationStore.resolveScopeProjectPaths） */
    scopeProjectPaths: string[]
    viewScope: ViewScope | null
    groups: ProjectGroupWithMembers[]
    /** 目标会话所属工作目录；未归属为 null */
    targetWorkspacePath: string | null
}): RunningSessionJumpPlan {
    const {scopeProjectPaths, viewScope, groups, targetWorkspacePath} = args
    // 未归属：无路径可跟随。组视图本就含未归属段（自然保留）；单项目视图也不为其强切。
    if (!targetWorkspacePath) return {kind: 'activate-only'}

    const targetKey = workspacePathKey(targetWorkspacePath)
    const inView = scopeProjectPaths.some(p => workspacePathKey(p) === targetKey)
    if (inView) return {kind: 'stay'}

    // 不在视图内：优先组视图（目标项目已入组 → 切到该组并定位），未入组才单项目跟随
    const group = groups.find(g => g.members.some(m => workspacePathKey(m.projectPath) === targetKey))
    if (group) return {kind: 'group', groupId: group.id}
    return {kind: 'project'}
}
