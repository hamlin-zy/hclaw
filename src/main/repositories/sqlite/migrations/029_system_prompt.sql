-- 029_system_prompt.sql
-- 为 conversations 表增加 system_prompt 字段，用于缓存系统提示词
-- 存量会话该列为 NULL，触发正常构建路径
ALTER TABLE conversations ADD COLUMN system_prompt TEXT;
