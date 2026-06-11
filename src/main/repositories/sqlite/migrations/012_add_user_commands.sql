-- 用户自定义命令表
CREATE TABLE IF NOT EXISTS user_commands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    args JSON DEFAULT '[]',
    tags JSON DEFAULT '[]',
    enabled INTEGER DEFAULT 1,
    trigger_type TEXT DEFAULT 'none',
    trigger_target TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
