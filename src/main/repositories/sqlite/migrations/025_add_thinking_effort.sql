-- 为 model_scheme_roles 表添加推理强度列（替代旧的 thinking_budget）
-- 每个角色可独立配置推理/思考强度（auto/low/medium/high/xhigh/max）

ALTER TABLE model_scheme_roles
    ADD COLUMN thinking_effort TEXT;
