-- 为 provider_models 表添加模型定价列（JSON：{input,output,cacheRead,cacheWrite}，USD/token；空串 = 未配置）
ALTER TABLE provider_models ADD COLUMN pricing TEXT NOT NULL DEFAULT '';
