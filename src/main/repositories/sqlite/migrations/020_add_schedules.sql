-- 020_add_schedules.sql
-- 定时任务调度表
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    cron_expression TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('agent', 'skill', 'command', 'script')),
    task_target TEXT NOT NULL,
    task_args JSON DEFAULT '[]',
    enabled INTEGER DEFAULT 1,
    paused INTEGER DEFAULT 0,
    paused_at INTEGER,
    last_run_at INTEGER,
    last_run_status TEXT DEFAULT 'none' CHECK(last_run_status IN ('none', 'running', 'success', 'failure')),
    last_run_conversation_id TEXT,
    run_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_schedules_paused ON schedules(paused);
CREATE INDEX IF NOT EXISTS idx_schedules_last_run_status ON schedules(last_run_status);
