/**
 * 会话统计查询范围类型定义（spec: docs/superpowers/specs/2026-09-17-project-group-design.md §9 / §4.3）
 *
 * 主进程仓储、IPC、preload、渲染端共用；主进程 `repositories/interfaces.ts` re-export 本模块
 * （避免主/渲染两份声明漂移）。
 *
 * scope 三种范围：
 *  - all：全部项目（会话管理页默认）
 *  - project：单项目（等价旧 `listWithStats(workspacePath)` 签名）
 *  - unassigned：未归属会话（workspacePath 为空，如 MCP 诊断弹窗 / scheduler 定时任务创建）
 *  - group：项目组内项目集。**路径列表由渲染端给出**——主进程没有 `resolveWorkspaceKey`，
 *           按 path 精确匹配，而组内成员路径的生效键口径由渲染端决定，故由渲染端提供生效键列表，
 *           避免"组成员路径写法不一致导致查不到会话"的既有坑。
 */
export type ConversationStatsScope =
    | {scope: 'all'}
    | {scope: 'project'; workspacePath: string}
    | {scope: 'unassigned'}
    | {scope: 'group'; groupId: string; workspacePaths: string[]}
