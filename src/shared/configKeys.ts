/**
 * 配置键常量（主进程 config-read/write 与渲染端共用）。
 *
 * 为什么单独放 shared：同一个键在主进程（SQLITE_KEYS 白名单，决定走 SQLite 还是 JSON 文件）
 * 与渲染端（configRead/configWrite 入参）各写一份字面量时，任一处改错都会让读写落到不同的
 * 存储后端（读回 null、静默丢配置）。收敛为单一导出，双向引用。
 */

/** 视图作用域持久化载荷（`{viewScope, collapsedGroupIds, singleViewWindowHintShown?}`）的配置键 */
export const PROJECT_GROUP_VIEW_CONFIG_KEY = 'project-group-view'

/** 侧栏状态持久化载荷（`{leftWidth, leftCollapsed, rightCollapsed}`）的配置键 */
export const SIDEBAR_STATE_CONFIG_KEY = 'sidebar-state'
