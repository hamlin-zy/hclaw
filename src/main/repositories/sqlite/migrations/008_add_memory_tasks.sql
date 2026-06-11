-- 记忆系统定时任务表
-- 用于管理周期性任务（如记忆清理）

CREATE TABLE IF NOT EXISTS memory_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    interval_seconds INTEGER NOT NULL,
    last_run_at INTEGER,
    next_run_at INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_tasks_enabled ON memory_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_memory_tasks_next_run ON memory_tasks(next_run_at);

-- 预定义任务类型
-- cleanup: 清理过期记忆
-- compact: 压缩记忆
-- sync: 同步向量缓存
