import {projectGroupRepo} from '../repositories/sqlite/projectGroupRepository'

/**
 * 项目组 IPC handler 注册。
 *
 * 与 configIPC 同口径：electron 惰性 require，保持主进程装配时机不变
 * （模块顶层 import electron 会把 electron 拉进 worker 依赖闭包，见
 * tests/main/deps/workerNoElectron.test.ts）。
 *
 * 通道命名沿用现有风格（全小写单词前缀）：`project-group:*`。
 *
 * ⚠ projectPath 一律由渲染端传 `resolveWorkspaceKey` 解析后的**生效键**
 * （主进程是 `WHERE path = ?` 精确匹配，没有归一化）。
 */
export function initProjectGroupIPC(): void {
    ipcMainHandle('project-group:list', () => projectGroupRepo.list())

    ipcMainHandle('project-group:create', (_event: any, name: string) => {
        if (!name || !name.trim()) return {ok: false, error: '项目组名称不能为空'}
        const id = `pg-${crypto.randomUUID()}`
        try {
            return projectGroupRepo.create(id, name.trim()) ? {ok: true, id} : {ok: false, error: '创建项目组失败'}
        } catch (err) {
            return {ok: false, error: String(err)}
        }
    })

    ipcMainHandle('project-group:rename', (_event: any, id: string, name: string) => {
        if (!id || !name?.trim()) return false
        return projectGroupRepo.rename(id, name.trim())
    })

    ipcMainHandle('project-group:dissolve', (_event: any, id: string) => projectGroupRepo.dissolve(id))
    ipcMainHandle('project-group:delete', (_event: any, id: string) => projectGroupRepo.remove(id))

    ipcMainHandle('project-group:assign', (_event: any, projectPath: string, groupId: string | null) => {
        if (!projectPath) return false
        const target = groupId ?? null
        // 仓储不校验目标组是否存在（悬空 id 会被 list() 静默丢弃），在此拦下
        if (target !== null && !projectGroupRepo.list().some(g => g.id === target)) return false
        return projectGroupRepo.assign(projectPath, target)
    })

    ipcMainHandle('project-group:reorder', (_event: any, payload: {groupIds?: string[]; groupId?: string; projectPaths?: string[]}) => {
        if (Array.isArray(payload?.groupIds)) return projectGroupRepo.reorderGroups(payload.groupIds)
        if (payload?.groupId && Array.isArray(payload?.projectPaths)) {
            return projectGroupRepo.reorderProjects(payload.groupId, payload.projectPaths)
        }
        return false
    })
}

/** 惰性取 ipcMain 的小包装（避免模块顶层 import electron） */
type Handler = (event: any, ...args: any[]) => unknown
function ipcMainHandle(channel: string, handler: Handler): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 惰性加载（同 configIPC）
    const {ipcMain} = require('electron')
    ipcMain.handle(channel, handler)
}
