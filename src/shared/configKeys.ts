/**
 * 配置键常量（主进程 config-read/write 与渲染端共用）。
 *
 * 为什么单独放 shared：同一个键在主进程（SQLITE_KEYS 白名单，决定走 SQLite 还是 JSON 文件）
 * 与渲染端（configRead/configWrite 入参）各写一份字面量时，任一处改错都会让读写落到不同的
 * 存储后端（读回 null、静默丢配置）。收敛为单一导出，双向引用。
 */

/**
 * 视图作用域持久化载荷（`{viewScope, expandedGroupIds, manualCollapsedGroupIds, singleViewWindowHintShown?}`）
 * 的配置键。
 * 2026-09-26 修订 D19：组视图段默认折叠，载荷由折叠集 `collapsedGroupIds` 反转为展开集
 * `expandedGroupIds`（手动展开集落盘）；D19 前的旧字段停读停写，键名不变。
 * 2026-10-14 三态修订：新增 `manualCollapsedGroupIds`（手动折叠集）——「激活即展开」的
 * 自动展开不得压过用户显式折叠，故折叠意图必须可持久化判别。换名而非复用旧 `collapsedGroupIds`：
 * 旧字段是「默认展开」体系的口径，同名不同义会让老 payload 被误套进「默认折叠」体系。
 */
export const PROJECT_GROUP_VIEW_CONFIG_KEY = 'project-group-view'

/** 侧栏状态持久化载荷（`{leftWidth, leftCollapsed, rightCollapsed, recentHeight}`）的配置键 */
export const SIDEBAR_STATE_CONFIG_KEY = 'sidebar-state'
