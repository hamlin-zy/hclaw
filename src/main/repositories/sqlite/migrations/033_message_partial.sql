-- 添加 is_partial 列到 messages 表
-- 标记消息是否为部分写入（心跳落库），用于崩溃后精确恢复
ALTER TABLE messages ADD COLUMN is_partial INTEGER NOT NULL DEFAULT 0;

UPDATE messages SET is_partial = 0 WHERE is_partial IS NULL;
