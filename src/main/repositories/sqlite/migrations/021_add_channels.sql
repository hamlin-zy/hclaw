-- 021_add_channels.sql
-- 多渠道接入：渠道配置 + 会话绑定

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('wecom', 'feishu', 'dingtalk', 'wechat')),
    enabled INTEGER DEFAULT 0,
    config JSON NOT NULL DEFAULT '{}',
    status TEXT DEFAULT 'disconnected' CHECK(status IN (
        'disconnected', 'connecting', 'connected', 'error'
    )),
    status_message TEXT DEFAULT '',
    last_connected_at INTEGER,
    error_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_bindings (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    channel_key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channel_bindings_channel ON channel_bindings(channel_id, channel_key);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_conversation ON channel_bindings(conversation_id);
