-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — service_memos (2026-07-21)
--  Reverses db/2026-07-21_service_memos.sql. Dropping the table takes its
--  policies, indexes and triggers with it via CASCADE. The memo-number
--  trigger function is dropped explicitly (it is used by nothing else); the
--  shared public.set_updated_at() function is left in place (other tables
--  use it).
-- ════════════════════════════════════════════════════════════════════

drop table if exists public.service_memos cascade;
drop function if exists public.set_service_memo_number();
