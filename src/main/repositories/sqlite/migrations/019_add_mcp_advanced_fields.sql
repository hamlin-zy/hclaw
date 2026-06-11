-- 为 mcps 表添加 MCP 标准配置的高级字段
-- cwd: 工作目录，用于 stdio 模式启动子进程
-- timeout: 工具调用超时（毫秒），默认 60000
-- auto_approve: 自动批准的工具列表（JSON 数组字符串）
-- deny_list: 拒绝调用的工具列表（JSON 数组字符串）

ALTER TABLE mcps
    ADD COLUMN cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE mcps
    ADD COLUMN timeout INTEGER NOT NULL DEFAULT 60000;
ALTER TABLE mcps
    ADD COLUMN auto_approve TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mcps
    ADD COLUMN deny_list TEXT NOT NULL DEFAULT '[]';
