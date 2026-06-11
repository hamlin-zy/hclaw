-- 添加 LLM 统计字段到 messages 表
-- 用于记录每条 assistant 消息的 LLM 调用 token 消耗

-- 添加 llm_stats 字段（JSON 格式存储）
ALTER TABLE messages ADD COLUMN llm_stats TEXT;
