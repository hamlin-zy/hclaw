-- 为所有工具设置默认超时时间（30秒 = 30000ms）
-- 如果 timeout 字段为 NULL，则更新为 30000

UPDATE tools
SET timeout = 30000,
    updated_at = UNIXEPOCH()
WHERE timeout IS NULL;

-- 或者强制设置所有工具超时时间为 30000ms（不管是否已设置）
-- UPDATE tools SET timeout = 30000, updated_at = UNIXEPOCH();