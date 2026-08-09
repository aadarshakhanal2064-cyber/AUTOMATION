-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — recorded_date (2026-08-09)
--  Reverses db/2026-08-09_arf_recorded_date.sql.
--
--  Dropping the column discards any date a user edited away from the
--  created_at default; created_at itself is untouched, so the approximate
--  information survives.
-- ════════════════════════════════════════════════════════════════════

drop index if exists public.arf_recorded_date_idx;

alter table public.audit_report_finalization
  drop column if exists recorded_date;
