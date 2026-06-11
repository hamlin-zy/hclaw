-- 为会话管理查询添加索引
-- listWithStats 查询中使用了 WHERE workspace_path=? ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_updated
    ON conversations(workspace_path, updated_at DESC);

-- 优化 JOIN 查询性能
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
    ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_message_blocks_message_id
    ON message_blocks(message_id);
