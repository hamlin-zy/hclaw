-- 任务批次持久化：待办任务按会话内的批次组织
CREATE TABLE task_batches (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE INDEX idx_task_batches_conv ON task_batches(conversation_id, status);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES task_batches(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    subtasks TEXT,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_batch ON tasks(batch_id);
