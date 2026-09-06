-- 为 provider_models 表添加模型级运行时参数列（模型详情弹窗配置）
-- 只增不改：全部 NULLABLE，旧数据 NULL = 未配置，运行时走优先级兜底
-- max_context_tokens: 最大上下文（token）；NULL = 未配置 → 运行时 OpenRouter 匹配 → 1M 兜底
-- temperature:        采样温度（0-2）；NULL = 未配置 → 运行时系统设置 defaultTemperature → 0
-- max_output_tokens:  最大输出（token）；NULL = 未配置 → 运行时系统设置 defaultMaxTokens
-- model_types:        模型类型 JSON 数组（如 ["text","image"]，对齐 OpenRouter input_modalities）；
--                     NULL = 未配置 → 回退旧 model_type 单值（只读兼容），仍无则运行时按命名模式推断

ALTER TABLE provider_models
    ADD COLUMN max_context_tokens INTEGER;
ALTER TABLE provider_models
    ADD COLUMN temperature REAL;
ALTER TABLE provider_models
    ADD COLUMN max_output_tokens INTEGER;
ALTER TABLE provider_models
    ADD COLUMN model_types TEXT;
