-- 024_remove_dingtalk_wecom.sql
-- 移除钉钉和企业微信渠道支持

-- SQLite 不支持直接修改 CHECK 约束，需要重建表
CREATE TABLE IF NOT EXISTS channels_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('feishu', 'wechat')),
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

-- 复制数据（只保留 feishu 和 wechat 的记录）
INSERT INTO channels_new
SELECT * FROM channels
WHERE type IN ('feishu', 'wechat');

-- 删除旧表
DROP TABLE channels;

-- 重命名新表
ALTER TABLE channels_new RENAME TO channels;

-- 重建索引（已在旧表上的索引随表删除而丢失）
CREATE INDEX IF NOT EXISTS idx_channel_bindings_channel ON channel_bindings(channel_id, channel_key);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_conversation ON channel_bindings(conversation_id);
