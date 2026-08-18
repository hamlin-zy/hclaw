-- LLM 用量：记录 providers 表服务商名（providers.name），供用量统计按服务商展示人类可读名
-- 035 已建表，必须 ALTER（CREATE IF NOT EXISTS 会跳过）；runMigrations 按文件名记录只跑一次
ALTER TABLE llm_usage ADD COLUMN provider_name TEXT;
