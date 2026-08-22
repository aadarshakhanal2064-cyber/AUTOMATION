-- ════════════════════════════════════════════════════════════════════════
--  ROLLBACK — VAT Register  (2026-08-22)
--
--  DESTRUCTIVE. Drops all three tables and every row in them: the firm's
--  typed purchase bills, its Masebari adjustments and its VAT collection
--  records. None of that is derivable from anywhere else — the sales side
--  is (it lives in service_memos and is untouched here), but these three
--  are the module's only copy.
--
--  Export before running this:
--      node tools/dbBackup.mjs
--
--  The triggers, indexes and policies go with their tables; nothing else in
--  the schema references them, so no other object needs repairing. In
--  particular public.set_updated_at() is SHARED with 16 other tables and is
--  deliberately left alone.
-- ════════════════════════════════════════════════════════════════════════

drop table if exists public.vat_collections;
drop table if exists public.vat_returns;
drop table if exists public.vat_purchases;
