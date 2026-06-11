-- 工具管理表：存储内置工具的启用状态
CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 内置工具默认数据（所有工具默认启用）
INSERT OR IGNORE INTO tools (id, name, description, enabled, created_at, updated_at) VALUES
    ('bash', 'bash', '在用户的工作目录中执行 shell 命令', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('file_read', 'file_read', '读取指定文件的内容', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('file_edit', 'file_edit', '精确替换文件中的文本片段', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('file_write', 'file_write', '将内容写入指定文件', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('glob', 'glob', '搜索文件', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('grep', 'grep', '在文件中搜索匹配的文本内容', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('web_fetch', 'web_fetch', '获取指定 URL 的内容', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('ask_user', 'ask_user', '向用户提问并等待回答', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('agent', 'agent', '派生子 Agent 处理子任务', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('skill', 'skill', '调用技能', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('memory_search', 'memory_search', '搜索长期记忆', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('memory_save', 'memory_save', '保存长期记忆', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('task_create', 'task_create', '创建待办事项', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('task_update', 'task_update', '更新待办状态', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('task_list', 'task_list', '列出待办事项', 1, UNIXEPOCH(), UNIXEPOCH());
