-- ════════════════════════════════════════════════════════════════════
--  DEPRECIATION — allow the Accounting-Standard (SLM) method (2026-07-21)
--
--  Adds a THIRD value to depreciation_schedules.scheme so the new
--  "Depreciation as per Accounting Standard (SLM)" method can save & carry
--  forward alongside the two Income-Tax schemes:
--
--    · 'normal'  = Depreciation as per Income Tax (reducing balance)
--    · 'special' = Special Industries (accelerated reducing balance)
--    · 'slm'     = Accounting Standard, Straight Line Method (NEW)
--
--  No new columns: for scheme='slm', the existing `pools` jsonb holds the
--  per-asset line array (class, dates, useful life, original cost, opening
--  WDV/depreciation, disposals, impairment + a snapshot of the computed
--  closings that next year's carry-forward reads). `addition_details` is
--  unused for SLM (stored as []). The unique key (client_id, scheme,
--  fiscal_year) already isolates the three methods per client-year.
--
--  RLS: unchanged — the table's membership policies (private.is_app_user)
--  cover every scheme value; a new CHECK value needs no new policy (§6.6).
--
--  Only the CHECK constraint changes (drop + re-add with the extra value).
--  Rollback: db/2026-07-21_slm_scheme_rollback.sql
-- ════════════════════════════════════════════════════════════════════

alter table public.depreciation_schedules
  drop constraint if exists depreciation_schedules_scheme_check;

alter table public.depreciation_schedules
  add constraint depreciation_schedules_scheme_check
  check (scheme in ('normal', 'special', 'slm'));
