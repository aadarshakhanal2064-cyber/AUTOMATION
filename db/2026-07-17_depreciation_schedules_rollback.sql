-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — depreciation_schedules (2026-07-17)
--  Reverses db/2026-07-17_depreciation_schedules.sql. Drops the table
--  (policies + trigger + index go with it via CASCADE). The shared
--  public.set_updated_at() function is left in place (used by other tables).
-- ════════════════════════════════════════════════════════════════════

drop table if exists public.depreciation_schedules cascade;
