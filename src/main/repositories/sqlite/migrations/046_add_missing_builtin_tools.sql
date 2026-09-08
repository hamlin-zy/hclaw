-- 补齐内置工具种子数据
-- 这些工具此前未写入 tools 表，导致工具管理界面无法展示与控制其启用状态
INSERT OR IGNORE INTO tools (id, name, description, enabled, created_at, updated_at) VALUES
    ('channel_list', 'channel_list', '列出所有已连接（含正在连接）的渠道，包含渠道名称、类型与连接状态', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('channel_send', 'channel_send', '通过指定渠道向用户发送消息（文本/媒体/图文）', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('scheduler_manage', 'scheduler_manage', '定时任务管理。支持列出、查看详情、创建、更新、删除、立即执行或停止任务', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('system_manage', 'system_manage', 'HClaw 系统管理。支持获取/更新系统配置以及重启应用', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('session_handoff', 'session_handoff', '总结当前任务并创建新会话继续工作，用于会话上下文过长时', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('memo_tool', 'memo_tool', '备忘录管理。支持列出、创建、更新、删除备忘录', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('describe_skills', 'describe_skills', '查看技能的详细描述与用法（只读）', 1, UNIXEPOCH(), UNIXEPOCH()),
    ('list_agents', 'list_agents', '列出当前可用的 Agent 名册（只读）', 1, UNIXEPOCH(), UNIXEPOCH());
