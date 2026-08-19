-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK of db/2026-08-18_stage2_phase2_backfill_org_id.sql
--
--  Clears org_id back to NULL on all 22 tenant-owned tables. The columns,
--  indexes, defaults and the three org tables all stay — that is Phase 1's
--  rollback, which can be run after this one if the whole stage is being
--  abandoned.
--
--  WHAT IS LOST: nothing. In a single-organisation database org_id carries no
--  information that isn't already implied — every row belongs to the only
--  organisation there is. The backfill is fully re-runnable afterwards.
--
--  ONLY SAFE BEFORE PHASE 3. Once Phase 3 has set NOT NULL, this file's UPDATE
--  fails on the constraint (correctly), and once its policies compare against
--  org_id, clearing the column would make every row invisible to the app.
--  Roll Phase 3 back first.
--
--  NOTE ON THE DEFAULT: Phase 1 set `default private.current_org_id()`, so any
--  row inserted AFTER this rollback runs will still be stamped. This clears
--  what exists; it does not stop new rows being owned. To fully return to
--  pre-Phase-1 behaviour, run Phase 1's rollback, which drops the columns.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  t       text;
  cleared bigint;
  total   bigint := 0;
begin
  foreach t in array array[
    'clients', 'client_shareholders',
    'send_logs', 'audit_log',
    'service_memos', 'service_memo_fee_skips',
    'depreciation_schedules',
    'bank_accounts', 'bank_transactions',
    'party_opening_balances',
    'financial_statements', 'projection_reports',
    'document_register', 'saved_documents',
    'audit_report_finalization', 'audit_checklists',
    'work_done', 'work_todos',
    'autobooks_books', 'autobooks_entries',
    'autobooks_parties', 'autobooks_adjustments'
  ] loop
    execute format('update public.%I set org_id = null where org_id is not null', t);
    get diagnostics cleared = row_count;
    total := total + cleared;
  end loop;

  raise notice 'Cleared org_id on % rows.', total;
end $$;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect stamped_rows 0. The 22 columns still exist and still carry their
-- default; only the values are gone.
select
  (select count(*) from clients                   where org_id is not null)
+ (select count(*) from client_shareholders       where org_id is not null)
+ (select count(*) from send_logs                 where org_id is not null)
+ (select count(*) from audit_log                 where org_id is not null)
+ (select count(*) from service_memos             where org_id is not null)
+ (select count(*) from service_memo_fee_skips    where org_id is not null)
+ (select count(*) from depreciation_schedules    where org_id is not null)
+ (select count(*) from bank_accounts             where org_id is not null)
+ (select count(*) from bank_transactions         where org_id is not null)
+ (select count(*) from party_opening_balances    where org_id is not null)
+ (select count(*) from financial_statements      where org_id is not null)
+ (select count(*) from projection_reports        where org_id is not null)
+ (select count(*) from document_register         where org_id is not null)
+ (select count(*) from saved_documents           where org_id is not null)
+ (select count(*) from audit_report_finalization where org_id is not null)
+ (select count(*) from audit_checklists          where org_id is not null)
+ (select count(*) from work_done                 where org_id is not null)
+ (select count(*) from work_todos                where org_id is not null)
+ (select count(*) from autobooks_books           where org_id is not null)
+ (select count(*) from autobooks_entries         where org_id is not null)
+ (select count(*) from autobooks_parties         where org_id is not null)
+ (select count(*) from autobooks_adjustments     where org_id is not null)
  as stamped_rows;
