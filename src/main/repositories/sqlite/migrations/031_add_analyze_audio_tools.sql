-- 为 analyze_image 和 speech_to_text 工具添加默认禁用记录
-- 这两个工具应当由模型方案的 image_understanding / audio_understanding 角色控制启用
-- 首次启动时加入 DB，确保新用户默认禁用，避免工具列表中出现未配置能力的工具
INSERT OR IGNORE INTO tools (id, name, description, enabled, created_at, updated_at) VALUES
    ('analyze_image', 'analyze_image', '分析图片内容（文字、物体、场景等）', 0, UNIXEPOCH(), UNIXEPOCH()),
    ('speech_to_text', 'speech_to_text', '【语音转文字 ASR】使用独立的音频多模态模型将音频转为文字', 0, UNIXEPOCH(), UNIXEPOCH());
