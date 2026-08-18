-- supports_thinking 列已废弃（死字段）：全代码库无任何读写消费点，
-- 思考能力由 scheme role 的 thinking_effort 配置驱动（model_scheme_roles.thinking_effort，
-- modelSelector.resolveModelConfig 解析进 modelConfig.thinkingEffort）。
-- 参考 023_drop_supports_vision.sql 的同类清理。
ALTER TABLE provider_models DROP COLUMN supports_thinking;
