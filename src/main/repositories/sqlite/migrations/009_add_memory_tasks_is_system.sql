-- 为 memory_tasks 表添加 is_system 字段
-- 用于标记系统内置任务，禁止用户删除

-- 添加 is_system 列（默认为 0，即用户自定义任务）
ALTER TABLE memory_tasks ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

-- 更新现有的默认任务为系统任务
UPDATE memory_tasks
SET is_system = 1
WHERE type IN ('cleanup', 'sync', 'induction', 'conflict_resolution', 'compact', 'confidence_decay');
