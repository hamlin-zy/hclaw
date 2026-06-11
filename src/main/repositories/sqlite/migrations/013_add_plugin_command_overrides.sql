-- 为 user_commands 表添加 source 和 plugin_command_id 字段
-- 用于支持插件命令的禁用/编辑状态复用 user_commands 表

ALTER TABLE user_commands
    ADD COLUMN source TEXT DEFAULT 'user';
ALTER TABLE user_commands
    ADD COLUMN plugin_command_id TEXT;
CREATE INDEX IF NOT EXISTS idx_user_commands_source ON user_commands(source);
