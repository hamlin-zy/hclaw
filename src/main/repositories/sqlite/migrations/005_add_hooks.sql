-- Hooks 表：存储用户定义的 Hook 配置
CREATE TABLE IF NOT EXISTS hooks (
    id          TEXT PRIMARY KEY,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    events      TEXT    NOT NULL,
    config      TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    source      TEXT    NOT NULL DEFAULT 'user',
    plugin_name TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Index for faster lookups by source and enabled status
CREATE INDEX IF NOT EXISTS idx_hooks_source ON hooks(source);
CREATE INDEX IF NOT EXISTS idx_hooks_enabled ON hooks(enabled);
