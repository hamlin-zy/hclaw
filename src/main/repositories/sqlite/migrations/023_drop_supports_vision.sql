-- supports_vision 列已废弃，视觉能力由 image_understanding 角色管理
ALTER TABLE provider_models DROP COLUMN supports_vision;
