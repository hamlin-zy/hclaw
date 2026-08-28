-- 041: 回填 llm_usage 中 provider_id 为 NULL 的历史行（用量统计同模型重复分组修复）
-- 背景：provider_id 列（038）引入之前写入的行 id 为 NULL，SQL GROUP BY provider_id,
-- provider_name, provider_type, model 会把同名同模型的 NULL-id 行与带 id 行拆成两条统计。
-- 策略：① (provider_name, provider_type) 精确命中 providers → 回填；
--       ② type 不匹配（历史上服务商改过类型）→ 仅当该 name 在 providers 中唯一时兜底回填；
--       ③ name 重名/无匹配 → 保持 NULL（归属有歧义，宁缺勿错）。
BEGIN;

UPDATE llm_usage
SET provider_id = (
    SELECT p.id FROM providers p
    WHERE p.name = llm_usage.provider_name AND p.type = llm_usage.provider_type
)
WHERE provider_id IS NULL
  AND provider_name IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM providers p
      WHERE p.name = llm_usage.provider_name AND p.type = llm_usage.provider_type
  );

UPDATE llm_usage
SET provider_id = (
    SELECT p.id FROM providers p WHERE p.name = llm_usage.provider_name
)
WHERE provider_id IS NULL
  AND provider_name IS NOT NULL
  AND (SELECT COUNT(*) FROM providers p WHERE p.name = llm_usage.provider_name) = 1;

COMMIT;
