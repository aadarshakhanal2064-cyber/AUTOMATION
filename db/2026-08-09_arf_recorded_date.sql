-- ════════════════════════════════════════════════════════════════════
--  AUDIT REPORT FINALIZATION — recorded_date (2026-08-09)
--
--  "Which day did we do this work?" — the date a record was logged, so the
--  module can be filtered by a date range ("what did we get through last
--  week?") rather than only by fiscal year.
--
--  · Deliberately a separate column rather than reusing created_at:
--    created_at is an immutable audit timestamp, while recorded_date is
--    USER-EDITABLE — staff routinely enter on Monday work that was actually
--    done on Friday, and the filter has to reflect the work, not the typing.
--  · Backfilled from created_at::date, which is the honest recorded date for
--    every row that exists today (nothing has been backdated yet).
--  · DEFAULT current_date so any insert that omits it — including the
--    chain's auto-created follow-on records — is stamped with today.
--  · Indexed descending: every read of this column is a recent-first range
--    scan from the filter bar.
--
--  Rollback: db/2026-08-09_arf_recorded_date_rollback.sql
-- ════════════════════════════════════════════════════════════════════

alter table public.audit_report_finalization
  add column if not exists recorded_date date;

update public.audit_report_finalization
   set recorded_date = created_at::date
 where recorded_date is null;

alter table public.audit_report_finalization
  alter column recorded_date set default current_date;

alter table public.audit_report_finalization
  alter column recorded_date set not null;

comment on column public.audit_report_finalization.recorded_date is
  'The day this work was logged (user-editable, defaults to today). Distinct from created_at, which is the immutable insert timestamp.';

create index if not exists arf_recorded_date_idx
  on public.audit_report_finalization (recorded_date desc);
