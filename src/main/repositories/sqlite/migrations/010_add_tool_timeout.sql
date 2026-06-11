-- 添加工具超时配置字段
-- 如果列已存在则忽略
ALTER TABLE tools ADD COLUMN timeout INTEGER;