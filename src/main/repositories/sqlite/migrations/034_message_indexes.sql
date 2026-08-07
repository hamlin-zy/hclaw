-- messages 表：替换单列索引为复合索引
-- (conversation_id, timestamp) 同时覆盖 WHERE conversation_id=? 和 ORDER BY timestamp
-- 消除 readMessages / readMessagesTail 中的临时排序
DROP INDEX IF EXISTS idx_messages_conversation_id;
CREATE INDEX idx_messages_conv_ts ON messages(conversation_id, timestamp);

-- message_blocks 表：复合索引覆盖 WHERE message_id IN (...) 和 ORDER BY message_id, sequence
-- buildMessagesFromRows 单次查询 172 blocks，消除按 message_id 分组后的 sequence 排序
DROP INDEX IF EXISTS idx_message_blocks_message_id;
CREATE INDEX idx_message_blocks_msg_seq ON message_blocks(message_id, sequence);
