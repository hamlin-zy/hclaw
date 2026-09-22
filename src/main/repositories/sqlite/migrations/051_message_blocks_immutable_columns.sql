-- 051_message_blocks_immutable_columns.sql
-- UPSERT 契约守卫：message_blocks 采用 UPSERT 语义（块 id 命中则 UPDATE，未命中则 INSERT 并 nextSeq() 分配 sequence），
-- 契约是 id / sequence / block_type / message_id 只在 INSERT 时确定，UPDATE 永不修改
-- （见 docs/superpowers/specs/2026-09-22-block-id-stabilize-and-upsert-guard-design.md 3.2）。
-- 现状靠自律：误写 UPDATE ... SET sequence = ... 会静默破坏块顺序契约
-- （同类历史 bug 见 historyConverter.ts 与 conversationRepository.ts 的注释）。
-- 本迁移在 SQL 层兜底：四列任一被 UPDATE 即 ABORT；合法列 content / data / timestamp / ended_at 不受影响。
-- ★ 已知盲区：REPLACE 路径不受本触发器管辖（INSERT OR REPLACE 在冲突时先 DELETE 旧行再 INSERT，
--   SQLite 的 BEFORE UPDATE 触发器不生效），全量写侧（messageBlockRepository / conversationRepository /
--   manager.impl 共 5 处）须自证不重排 sequence；边界已由
--   tests/main/repositories/messageBlocksImmutable.test.ts 固化（守卫要覆盖 REPLACE 前须先改该用例）。
CREATE TRIGGER IF NOT EXISTS trg_message_blocks_immutable_cols
BEFORE UPDATE OF id, sequence, block_type, message_id ON message_blocks
BEGIN
  SELECT RAISE(ABORT, 'message_blocks: id/sequence/block_type/message_id are immutable');
END;
