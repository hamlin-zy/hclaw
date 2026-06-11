-- 为 provider_models 表添加模型能力标记列
-- supports_vision: 是否支持视觉理解（图片输入）
-- supports_thinking: 是否支持扩展思考/推理

ALTER TABLE provider_models
    ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_models
    ADD COLUMN supports_thinking INTEGER NOT NULL DEFAULT 0;
