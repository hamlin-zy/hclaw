-- 044：清理 provider_models 的 model_types 回退脏数据
-- 背景：历史版本在 repository 读取时把 model_types=NULL 回退成 [model_type]（单元素数组），
--       该回退值经保存流程（sqliteStorage.setItem 透传）被持久化回库，污染了整列。
--       model_types 语义应为 NULL = 未配置（回退旧 model_type 单值，见 migration 043）。
-- 本迁移把「单元素数组且元素 === model_type」的回退值清理为 NULL。
-- 消费方 modelSelector 已按 modelType 兜底（model.modelTypes ?? [model.modelType]），语义不变。
-- 说明：pricing 的 0 值脏数据不在此清理，由 hasCustomParams 的 >0 判断在渲染层防御。

UPDATE provider_models
SET model_types = NULL
WHERE model_types IS NOT NULL
  AND model_types != ''
  AND json_valid(model_types)
  AND json_array_length(model_types) = 1
  AND json_extract(model_types, '$[0]') = model_type;
