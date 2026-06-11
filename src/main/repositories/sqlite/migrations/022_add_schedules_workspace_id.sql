-- schedules 表新增工作目录字段
-- 定时任务所属的工作目录，用于创建会话时设置 workspacePath
ALTER TABLE schedules ADD COLUMN workspace_id TEXT DEFAULT NULL;

-- 索引：按工作目录查询定时任务
CREATE INDEX IF NOT EXISTS idx_schedules_workspace_id ON schedules(workspace_id);
