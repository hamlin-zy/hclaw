-- 项目组（workspaces 的上一层级；一个项目最多属于一个组）
-- 现有项目全部 group_id = NULL（= 顶层项目 / 未分组），零数据迁移。

CREATE TABLE IF NOT EXISTS project_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

ALTER TABLE workspaces ADD COLUMN group_id    TEXT;     -- NULL = 未分组（顶层项目）
ALTER TABLE workspaces ADD COLUMN group_order INTEGER;  -- 组内顺序（NULL = 未指定，排最后）

-- 抽屉 / 组视图 / 会话管理筛选都按组取成员，属高频查询
CREATE INDEX IF NOT EXISTS idx_workspaces_group ON workspaces(group_id);
