-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — audit_report_finalization (2026-08-09)
--  Reverses db/2026-08-09_audit_report_finalization.sql. Dropping the
--  table takes its policies, indexes and trigger with it via CASCADE. The
--  shared public.set_updated_at() function is left in place (other tables
--  use it).
-- ════════════════════════════════════════════════════════════════════

drop table if exists public.audit_report_finalization cascade;
