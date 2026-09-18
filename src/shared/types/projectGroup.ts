/**
 * 项目组类型定义（spec: docs/superpowers/specs/2026-09-17-project-group-design.md §4）
 *
 * 主进程仓储与渲染端共用；主进程仓储 re-export 本模块（避免重复声明）。
 */
export interface ProjectGroup {
    id: string
    name: string
    sortOrder: number
    createdAt: number
    updatedAt: number
}

export interface ProjectGroupMember {
    /** 项目路径（主进程原串；渲染端比较请用 workspacePathKey） */
    projectPath: string
    groupOrder: number
}

export interface ProjectGroupWithMembers extends ProjectGroup {
    /** 成员项目（按 group_order 升序；group_order 为 NULL 者排在最后） */
    members: ProjectGroupMember[]
}

export type ProjectGroupCreateResult = {ok: true; id: string} | {ok: false; error: string}
