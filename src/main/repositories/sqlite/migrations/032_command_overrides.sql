-- 命令覆盖管理表
-- 存储用户对命令启用/禁用状态的覆盖（仅记录与文件默认状态不同的值）
CREATE TABLE IF NOT EXISTS command_overrides (
    command_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
