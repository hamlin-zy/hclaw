-- HClaw 扩展 Schema v3: 模型方案表
-- model_schemes 表：方案元数据
CREATE TABLE IF NOT EXISTS model_schemes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- model_scheme_roles 表：每个方案的角色配置
CREATE TABLE IF NOT EXISTS model_scheme_roles (
  id TEXT PRIMARY KEY,
  scheme_id TEXT NOT NULL,
  role TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_type TEXT NOT NULL DEFAULT 'text',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (scheme_id) REFERENCES model_schemes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_roles_scheme ON model_scheme_roles(scheme_id);
