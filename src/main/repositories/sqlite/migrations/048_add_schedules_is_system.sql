-- 048_add_schedules_is_system.sql
-- 为 schedules 表添加 is_system 字段，标记系统内置定时任务
ALTER TABLE schedules ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_schedules_is_system ON schedules(is_system);
