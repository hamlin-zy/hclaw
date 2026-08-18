-- LLM 用量独立表（token 用量唯一数据源）
-- 指标全部展开成列（无 JSON/数组），支持 SQL 下推聚合（GROUP BY provider_type, model）
CREATE TABLE IF NOT EXISTS llm_usage (
  id                 TEXT    PRIMARY KEY,          -- 幂等 ID：usage_<messageId>_<seq>
  conversation_id    TEXT    NOT NULL,             -- 实际发生 LLM 调用的会话
  message_id         TEXT    NOT NULL,             -- 关联的 assistant 消息（所有 llm_call_done 均有关联消息）
  provider_type      TEXT    NOT NULL,             -- 服务商类型 anthropic/openai/google/ollama/custom
  model              TEXT    NOT NULL,             -- 模型 ID

  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  ttft_ms            INTEGER,                      -- 首字延迟，可空
  decode_ms          INTEGER,                      -- 纯解码时长，可空
  duration_ms        INTEGER NOT NULL DEFAULT 0,   -- 调用耗时

  created_at         INTEGER NOT NULL,             -- 毫秒时间戳

  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- 会话维度：会话弹窗统计、B1 按会话组装
CREATE INDEX idx_llm_usage_conv ON llm_usage(conversation_id, created_at);
-- 消息维度：B1 按 message_id 组装 Message.llmStats
CREATE INDEX idx_llm_usage_message ON llm_usage(message_id);
-- 服务商/模型维度：全局聚合（GROUP BY provider_type, model）
CREATE INDEX idx_llm_usage_provider_model ON llm_usage(provider_type, model);
-- 时间维度：趋势图按时间范围过滤
CREATE INDEX idx_llm_usage_created ON llm_usage(created_at);
