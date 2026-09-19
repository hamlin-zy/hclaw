-- 为 provider_models 表添加「OpenRouter 固定服务商」列（模型详情弹窗配置）
-- 只增不改：NULLABLE，旧数据 NULL = 未配置，运行时走自动路由
-- open_router_provider: OpenRouter 服务商 slug（如 deepinfra、deepinfra/turbo）；
--                       NULL = 未配置 → 自动路由（不注入 provider 参数）

ALTER TABLE provider_models
    ADD COLUMN open_router_provider TEXT;
