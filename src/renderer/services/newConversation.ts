import {useConversationStore} from '../stores/conversationStore'
import {useProjectGroupStore} from '../stores/projectGroupStore'
import {UNASSIGNED_WORKSPACE_KEY, workspacePathKey} from '../lib/workspacePath'

/**
 * 新建会话的唯一入口（顶部大按钮 / 段头「+」/ Ctrl+N 共用）。
 *
 * 目标项目解析（spec D6 / §15.1①）：
 *   显式传入 workspacePath → 用它（段头「+」/ 抽屉层 2「添加项目」）
 *   否则 → 激活会话所属项目 → currentWorkspacePath → 弹选夹框问用户
 *
 * 视图归属：
 *   stayInScope=true（组视图内新建）→ 停留组视图 + 定位该项目段（不跟随）
 *   否则（Ctrl+N 等跨项目跳转类）→ 跟随视图，保证新会话可见
 *   ★ 例外：目标为未归属虚拟键（UNASSIGNED_WORKSPACE_KEY，如激活的是定时任务
 *     会话后按 Ctrl+N）→ 恒停留：虚拟键不是真实项目（workspacePath.ts 约定仅内存
 *     使用，不落库 / 不传主进程），跟随会把 viewScope 切成「未归属」单项目视图、
 *     还把虚拟键写进 currentWorkspacePath（违反两处既有约定）。此前未拦截的症状：
 *     未归属会话激活时按 Ctrl+N，顶部视图被切走。新会话本身仍归未归属段
 *     （createConversation 对虚拟键落库空路径 + 插未归属段）。
 */
export async function newConversation(opts?: {
    workspacePath?: string
    stayInScope?: boolean
}): Promise<string | null> {
    const store = useConversationStore.getState()
    let target = opts?.workspacePath ?? workspaceOfActiveConversation() ?? store.currentWorkspacePath
    if (!target) {
        const picked = await window.electronAPI?.openFolderDialog?.()
        if (!picked) return null
        // 对话框分支：目标项目必是尚未登记的路径 → 必须先登记再创建（与旧按钮逐字一致）。
        // createConversation 只创建会话、不登记工作区（不建 DB 记录、不同步主进程当前项目），
        // 漏掉这步会让「全新无项目时新建」把会话落到未登记路径上。
        await store.setWorkspace(picked)
        target = picked
    }
    const follow = target !== UNASSIGNED_WORKSPACE_KEY && !stayInScope(target, opts?.stayInScope)
    const id = await store.createConversation(undefined, {workspacePath: target, follow})
    if (!follow) store.focusProjectSegment(target)
    else store.followScopeToProject(target)
    return id
}

/**
 * 是否应停留当前视图（不跟随）：显式 stayInScope，或当前正处在组视图且目标项目
 * 属于该组——组内新建会话 ≠ 离开组视图（与组内点其他成员会话不写 viewScope 同理），
 * 跟随会把用户踢出组视图；此时只做段内滚动定位（focusProjectSegment）即可。
 * 目标不在当前组内（真正的跨项目跳转）→ 维持跟随，保证新会话可见。
 */
function stayInScope(target: string, explicit: boolean | undefined): boolean {
    if (explicit) return true
    const {viewScope} = useConversationStore.getState()
    if (viewScope?.type !== 'group') return false
    const group = useProjectGroupStore.getState().groups.find(g => g.id === viewScope.groupId)
    // 归一化键比较（与 handleSessionCreated 的 inCurrentGroup 同口径）：Windows 忽略
    // 大小写、去尾分隔符后同一目录不应被误判为「组外」而强制跟随（第二真相止血）。
    return group?.members.some(m => workspacePathKey(m.projectPath) === workspacePathKey(target)) ?? false
}

/** 激活会话所属项目（无激活会话 / 找不到 → null） */
function workspaceOfActiveConversation(): string | null {
    const state = useConversationStore.getState()
    if (!state.activeConversationId) return null
    for (const [path, info] of Object.entries(state.workspaces)) {
        if (info.conversations.some(c => c.id === state.activeConversationId)) return path
    }
    return null
}
