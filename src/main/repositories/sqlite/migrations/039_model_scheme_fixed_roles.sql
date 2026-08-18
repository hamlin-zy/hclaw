BEGIN;

-- 模型方案固定 6 角色 + providers.api_style
-- 背景（设计文档 2026-08-18）：
--   1. 删除自定义角色（UUID role）与 5 个生成类死角色（image_generation / video_generation /
--      voice_clone / voice_synthesis / music_generation）——这三者无任何消费方（auto 意图分析 /
--      Agent 类型 / 跨方案持久化均不支持），属于"配置了但不生效"的隐性陷阱。
--   2. display_name / icon / description 重置为固定值（MODEL_ROLE_INFO 为唯一来源）。
--   3. providers 表加 api_style 列（chat / responses，默认 chat），支撑 OpenAI Responses API。
-- 注意：迁移执行器 db.exec 逐文件执行、无隐式事务，此处显式 BEGIN/COMMIT 保证原子性；
--       删除自定义角色行不可逆，升级前须备份数据库。

-- 1. 删除自定义角色与生成类死角色
DELETE FROM model_scheme_roles
WHERE role NOT IN
  ('primary', 'lightweight', 'reasoning', 'image_understanding', 'audio_understanding', 'video_understanding');

-- 2. 重置存量行 display_name / icon / description 为固定值
UPDATE model_scheme_roles SET
  display_name = CASE role
    WHEN 'primary' THEN '主力模型'
    WHEN 'lightweight' THEN '轻量模型'
    WHEN 'reasoning' THEN '推理模型'
    WHEN 'image_understanding' THEN '图像理解'
    WHEN 'audio_understanding' THEN '音频理解'
    WHEN 'video_understanding' THEN '视频理解'
  END,
  icon = CASE role
    WHEN 'primary' THEN '🎯'
    WHEN 'lightweight' THEN '💬'
    WHEN 'reasoning' THEN '🧠'
    WHEN 'image_understanding' THEN '📷'
    WHEN 'audio_understanding' THEN '🎧'
    WHEN 'video_understanding' THEN '🎬'
  END,
  description = CASE role
    WHEN 'primary' THEN '主力模型 · 常规任务执行 · 复杂任务兜底'
    WHEN 'lightweight' THEN '轻量模型 · 简单对话 · 后台轻量任务'
    WHEN 'reasoning' THEN '推理模型 · 复杂任务规划 · 深度推理分析'
    WHEN 'image_understanding' THEN '分析图片内容。需配置支持 OpenAI 兼容视觉接口（image_url 输入）的模型，配置后启用 analyze_image 工具。'
    WHEN 'audio_understanding' THEN '分析音频内容。需配置支持 OpenAI 兼容音频接口（input_audio 输入）的模型，配置后启用 speech_to_text 工具。'
    WHEN 'video_understanding' THEN '视频内容分析。需配置支持 OpenAI 兼容视频接口（video_url / 抽帧图片列表输入）的模型，预留供未来视频分析工具使用。'
  END
WHERE role IN
  ('primary', 'lightweight', 'reasoning', 'image_understanding', 'audio_understanding', 'video_understanding');

-- 3. providers 表加 api_style 列，默认 'chat'（存量数据无感）
ALTER TABLE providers ADD COLUMN api_style TEXT NOT NULL DEFAULT 'chat';

COMMIT;
