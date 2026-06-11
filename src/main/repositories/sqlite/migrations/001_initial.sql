-- HClaw 初始数据库 schema v2
-- 注意：001_initial.sql 是全新的初始结构，不是增量迁移

-- migrations 表：追踪已执行的迁移脚本
CREATE TABLE IF NOT EXISTS migrations
(
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    executed_at INTEGER NOT NULL
);

-- workspaces 表：管理工作目录列表
CREATE TABLE IF NOT EXISTS workspaces
(
    id         TEXT PRIMARY KEY,
    path       TEXT    NOT NULL UNIQUE,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- system_settings 表：key-value 系统配置
-- 用于存储：current_workspace_id, current_model_scheme_id, permission_mode 等
CREATE TABLE IF NOT EXISTS system_settings
(
    key TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 会话表
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 消息表（assistant 消息的 content 存放在 message_blocks 中）
CREATE TABLE IF NOT EXISTS messages (
                                        id       TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  ended_at INTEGER,
                                        metadata TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- 消息块表（用于拆分 assistant 消息的不同部分）
CREATE TABLE IF NOT EXISTS message_blocks
(
    id         TEXT PRIMARY KEY,
    message_id TEXT    NOT NULL,
    block_type TEXT    NOT NULL,
    content    TEXT,
    data       TEXT,
    sequence   INTEGER NOT NULL,
    timestamp  INTEGER NOT NULL,
    ended_at   INTEGER,
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
);

-- 权限规则表
CREATE TABLE IF NOT EXISTS permission_rules (
  tool TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
