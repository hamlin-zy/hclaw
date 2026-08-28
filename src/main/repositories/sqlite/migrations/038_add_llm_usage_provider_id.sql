-- T4：llm_usage 增加稳定服务商维度 provider_id（providers.id）
-- 035 已建表，必须 ALTER（CREATE IF NOT EXISTS 会跳过）；runMigrations 按文件名记录只跑一次
ALTER TABLE llm_usage ADD COLUMN provider_id TEXT;
