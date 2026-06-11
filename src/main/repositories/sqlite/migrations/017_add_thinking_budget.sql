-- 为 model_scheme_roles 表添加推理预算列
-- 每个角色可独立配置思考/推理 token 预算

ALTER TABLE model_scheme_roles
    ADD COLUMN thinking_budget INTEGER;
