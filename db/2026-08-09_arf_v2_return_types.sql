-- ════════════════════════════════════════════════════════════════════
--  AUDIT REPORT FINALIZATION v2 — per-return-type records (2026-08-09)
--
--  Reshapes audit_report_finalization from "one row per (client, fiscal
--  year) covering all three tracks" to "one row per (client, fiscal year,
--  RETURN TYPE)". IT return, estimate return and tax clearance are separate
--  pieces of work, entered by different staff at different times, so they
--  now get their own rows and their own independent status.
--
--  Applied against 7 LIVE rows (all IT-return work for FY 2082/83). Every
--  step below is ordered so those rows survive and stay correct.
--
--  · auditor loses its CHECK — the UI now offers "Other, type a name", so
--    it becomes free text (the clients.it_return_type precedent). The two
--    partner names are renamed to the FIRM names they actually represent,
--    matching REP_FIRMS in js/config.js:
--        'Shailesh Dallakoti'      -> 'Shailesh & Associates'
--        'Devi Prasad Dallakoti'   -> 'Dallakoti & Company'
--    'Non-Sign', 'Lila Adhikari' and 'Surya Poudel' are unchanged.
--  · return_type is added nullable, backfilled to 'it_return' for every
--    existing row (they are all IT-return records), then made NOT NULL.
--  · estimate_checked_by -> estimate_entered_by: the estimate track records
--    who ENTERED it, mirroring the IT track's wording. Every value is null
--    today, so this rename cannot lose data.
--  · it_checked_by is new and is NOT a rename of anything — the IT track
--    now distinguishes who entered the submission from who checked it.
--  · Both submission numbers are CHECK-constrained to exactly 12 digits
--    when present, so a malformed number can't arrive by any path (the UI
--    also blocks it, but the UI is not the only way in). All 7 live values
--    already satisfy this.
--
--  Rollback: db/2026-08-09_arf_v2_return_types_rollback.sql
--  NOTE: the rollback cannot restore the pre-rename auditor spellings for
--  rows edited after this migration — see that file's header.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. auditor becomes free text, and the partner names become firm names ──
alter table public.audit_report_finalization
  drop constraint if exists audit_report_finalization_auditor_check;

update public.audit_report_finalization
   set auditor = 'Shailesh & Associates'
 where auditor = 'Shailesh Dallakoti';

update public.audit_report_finalization
   set auditor = 'Dallakoti & Company'
 where auditor = 'Devi Prasad Dallakoti';

-- ── 2. return_type: add nullable, backfill, then enforce ──
alter table public.audit_report_finalization
  add column if not exists return_type text;

update public.audit_report_finalization
   set return_type = 'it_return'
 where return_type is null;

alter table public.audit_report_finalization
  alter column return_type set not null;

alter table public.audit_report_finalization
  drop constraint if exists arf_return_type_check;
alter table public.audit_report_finalization
  add constraint arf_return_type_check
  check (return_type in ('it_return', 'estimate_return', 'tax_clearance'));

-- ── 3. One record per (client, fiscal year, return type) ──
alter table public.audit_report_finalization
  drop constraint if exists audit_report_finalization_client_fy_uniq;
alter table public.audit_report_finalization
  add constraint audit_report_finalization_client_fy_type_uniq
  unique (client_id, fiscal_year, return_type);

-- ── 4. New per-track columns ──
alter table public.audit_report_finalization
  add column if not exists it_return_type         text,
  add column if not exists it_checked_by          text,
  add column if not exists estimate_submission_no text,
  add column if not exists tax_clearance_remarks  text;

alter table public.audit_report_finalization
  drop constraint if exists arf_it_return_type_check;
alter table public.audit_report_finalization
  add constraint arf_it_return_type_check
  check (it_return_type is null or it_return_type in ('D-2', 'D-3'));

-- ── 5. The estimate track records who ENTERED it (all values null today) ──
alter table public.audit_report_finalization
  rename column estimate_checked_by to estimate_entered_by;

-- ── 6. Submission numbers are exactly 12 digits when present ──
alter table public.audit_report_finalization
  drop constraint if exists arf_it_submission_no_check;
alter table public.audit_report_finalization
  add constraint arf_it_submission_no_check
  check (it_submission_no is null or it_submission_no ~ '^[0-9]{12}$');

alter table public.audit_report_finalization
  drop constraint if exists arf_estimate_submission_no_check;
alter table public.audit_report_finalization
  add constraint arf_estimate_submission_no_check
  check (estimate_submission_no is null or estimate_submission_no ~ '^[0-9]{12}$');

-- ── 7. Index the new discriminator (every filter and the chart group by it) ──
create index if not exists arf_return_type_idx
  on public.audit_report_finalization (return_type);

comment on table public.audit_report_finalization is
  'Per-client, per-fiscal-year, per-return-type tracker for IT return / Estimate return submission & tax clearance status (Audit Report Finalization module).';
