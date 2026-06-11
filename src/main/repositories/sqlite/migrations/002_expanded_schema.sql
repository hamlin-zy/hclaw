-- HClaw 扩展 Schema v2
-- 新增：mcps, plugins, accounts, agents, providers, provider_models 表
-- 迁移：system_settings 初始化数据（从本地文件迁移到 SQLite）

-- 初始化 system_settings 数据（UI 系统设置）
-- 注意：key='settings' 存储完整的 SystemSettings 对象，供 renderer 和 manager 共用
INSERT OR
REPLACE INTO system_settings (key, value, updated_at)
VALUES (
    'settings', '{"agent":{"maxTurns":500,"retryCount":10,"initialRetryDelay":5000,"maxRetryDelay":120000,"llmTimeout":600000,"compactThreshold":700000},"model":{"defaultMaxTokens":8000,"defaultTemperature":0},"mcp":{"mcpTestTimeout":15000},"ui":{"language":"zh-CN","theme":"system"}}', strftime('%s', 'now') * 1000
    );

-- mcps 表：MCP 服务器配置
CREATE TABLE IF NOT EXISTS mcps
(
    id               TEXT PRIMARY KEY,
    name             TEXT    NOT NULL,
    transport        TEXT    NOT NULL DEFAULT 'stdio',
    command          TEXT    NOT NULL,
    args             TEXT    NOT NULL DEFAULT '[]',
    env              TEXT    NOT NULL DEFAULT '{}',
    url              TEXT    NOT NULL DEFAULT '',
    user_description TEXT             DEFAULT '',
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

-- plugins 表：插件配置
CREATE TABLE IF NOT EXISTS plugins
(
    name       TEXT PRIMARY KEY,
    path       TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- accounts 表：认证账户
CREATE TABLE IF NOT EXISTS accounts
(
    id         TEXT PRIMARY KEY,
    name       TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    remark     TEXT             DEFAULT '',
    url        TEXT             DEFAULT '',
    username   TEXT             DEFAULT '',
    passwd     TEXT             DEFAULT '',
    encrypted  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- agents 表：Agent 模板
CREATE TABLE IF NOT EXISTS agents
(
    id          TEXT PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT             DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    is_system   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- providers 表：LLM 服务商配置
CREATE TABLE IF NOT EXISTS providers
(
    id          TEXT PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    type        TEXT    NOT NULL,
    auth_type   TEXT    NOT NULL DEFAULT 'api-key',
    base_url    TEXT    NOT NULL DEFAULT '',
    credentials TEXT    NOT NULL DEFAULT '{}',
    email       TEXT    NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- provider_models 表：服务商模型配置
CREATE TABLE IF NOT EXISTS provider_models
(
    id          TEXT PRIMARY KEY,
    provider_id TEXT    NOT NULL,
    model_name  TEXT    NOT NULL,
    model_type  TEXT    NOT NULL DEFAULT 'text',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (provider_id) REFERENCES providers (id) ON DELETE CASCADE,
    UNIQUE (provider_id, model_name)
);
