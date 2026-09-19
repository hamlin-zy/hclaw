-- 049_cleanup_legacy_memory.sql
-- 清理历史遗留的记忆系统（已删除的功能，仅表结构残留）
DROP TABLE IF EXISTS memory_tasks;
DELETE FROM tools WHERE id IN ('memory_search', 'memory_save');
