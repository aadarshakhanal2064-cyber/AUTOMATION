-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — work_done (2026-08-09)
--  Reverses db/2026-08-09_work_done.sql. Dropping the table takes its
--  policies, indexes and trigger with it via CASCADE. The shared
--  public.set_updated_at() function is left in place (other tables use it).
--
--  Nothing else references work_done — the Work Done module's Pending List
--  reads public.document_register, but that dependency runs one way and
--  File In Out is unaffected by this table disappearing.
-- ════════════════════════════════════════════════════════════════════

drop table if exists public.work_done cascade;
