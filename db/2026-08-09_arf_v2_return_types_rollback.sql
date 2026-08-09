-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — Audit Report Finalization v2 (2026-08-09)
--  Reverses db/2026-08-09_arf_v2_return_types.sql.
--
--  ⚠ NOT a perfect inverse, by nature:
--
--  · The auditor rename is reversed by mapping the firm names BACK to the
--    partner names. Any row saved after the migration with a free-text
--    "Other" auditor, or with 'Shailesh & Associates'/'Dallakoti & Company'
--    chosen deliberately as a firm rather than as the renamed partner, is
--    indistinguishable from a migrated row — it will be rewritten to the
--    partner name and then must satisfy the restored CHECK. Rows whose
--    auditor is none of the five original values will VIOLATE that CHECK
--    and block this rollback; clean them up first (the final statement is
--    written last on purpose so the data fixes above it have already run).
--  · Rows created after the migration for 'estimate_return' or
--    'tax_clearance' will collide with the restored
--    UNIQUE (client_id, fiscal_year) if the same client+year also has an
--    'it_return' row. Delete or re-key those rows before rolling back.
--  · Dropping the new columns discards whatever was entered in them.
-- ════════════════════════════════════════════════════════════════════

-- ── Reverse the column rename ──
alter table public.audit_report_finalization
  rename column estimate_entered_by to estimate_checked_by;

-- ── Drop the v2 constraints and columns ──
alter table public.audit_report_finalization
  drop constraint if exists arf_it_submission_no_check,
  drop constraint if exists arf_estimate_submission_no_check,
  drop constraint if exists arf_it_return_type_check,
  drop constraint if exists arf_return_type_check;

drop index if exists public.arf_return_type_idx;

alter table public.audit_report_finalization
  drop column if exists it_return_type,
  drop column if exists it_checked_by,
  drop column if exists estimate_submission_no,
  drop column if exists tax_clearance_remarks,
  drop column if exists return_type;

-- ── Restore the two-column uniqueness ──
alter table public.audit_report_finalization
  drop constraint if exists audit_report_finalization_client_fy_type_uniq;
alter table public.audit_report_finalization
  add constraint audit_report_finalization_client_fy_uniq
  unique (client_id, fiscal_year);

-- ── Restore the partner names, then the CHECK (see the caveats above) ──
update public.audit_report_finalization
   set auditor = 'Shailesh Dallakoti'
 where auditor = 'Shailesh & Associates';

update public.audit_report_finalization
   set auditor = 'Devi Prasad Dallakoti'
 where auditor = 'Dallakoti & Company';

alter table public.audit_report_finalization
  add constraint audit_report_finalization_auditor_check
  check (auditor in ('Shailesh Dallakoti', 'Non-Sign', 'Devi Prasad Dallakoti', 'Lila Adhikari', 'Surya Poudel'));

comment on table public.audit_report_finalization is
  'Per-client, per-fiscal-year tracker for IT return / Estimate return submission & tax clearance status (Audit Report Finalization module).';
