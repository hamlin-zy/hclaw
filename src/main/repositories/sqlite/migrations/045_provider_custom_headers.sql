-- 服务商自定义请求头（value = 固定前缀 + 系统变量（可选））
-- variable: NULL = 纯静态值（此时 header value 即 prefix）
-- 首版变量：system.version（应用版本号）、session.id（会话 ID）

CREATE TABLE IF NOT EXISTS provider_custom_headers (
    id          TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    header_name TEXT NOT NULL,
    prefix      TEXT,
    variable    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
)
