-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — revert depreciation_schedules.scheme to two values
--  (undoes db/2026-07-21_slm_scheme.sql)
--
--  WARNING: this re-adds the CHECK (scheme in ('normal','special')). It will
--  FAIL if any scheme='slm' rows still exist. Remove them first if you truly
--  intend to roll back (destructive — deletes saved SLM schedules):
--     -- delete from public.depreciation_schedules where scheme = 'slm';
-- ════════════════════════════════════════════════════════════════════

alter table public.depreciation_schedules
  drop constraint if exists depreciation_schedules_scheme_check;

alter table public.depreciation_schedules
  add constraint depreciation_schedules_scheme_check
  check (scheme in ('normal', 'special'));
