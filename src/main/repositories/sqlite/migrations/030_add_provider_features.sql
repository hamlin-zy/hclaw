-- 为 providers 表添加 features 字段（JSON，存储扩展特性如 systemContentBlocks）
ALTER TABLE providers ADD COLUMN features TEXT NOT NULL DEFAULT '{}';
