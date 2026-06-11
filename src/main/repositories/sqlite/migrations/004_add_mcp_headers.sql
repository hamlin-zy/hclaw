-- 添加 MCP 服务器的 headers 支持 (用于 HTTP/SSE 类型的 MCP 服务)
-- headers 用于存储自定义 HTTP 头，如 API Key 等认证信息

-- 检查 headers 列是否存在，如果不存在则添加
-- SQLite 不支持 IF NOT EXISTS 用于列，所以需要用这种方式
ALTER TABLE mcps ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';
