-- ════════════════════════════════════════════════════════════════════════════
--  STAGE 2 · PHASE 2 — backfill org_id. Still nothing enforced.
--
--  Part of converting this app from one firm to ~10. Full scope:
--  https://claude.ai/code/artifact/c372d471-8003-4d50-8bd7-92197ee2094c
--
--  Depends on: db/2026-08-18_stage2_phase1_tenant_scaffold.sql
--
--  WHAT THIS DOES
--    Stamps every pre-existing row in the 22 tenant-owned tables with the one
--    organisation that exists today, then REFUSES TO FINISH if a single NULL
--    is left anywhere.
--
--  WHY THE SELF-CHECK IS THE POINT OF THIS FILE
--    Phase 3 turns the policies on. The failure that matters is not a step
--    that errors — it is a table whose policy starts comparing org_id while
--    its rows never got one. Every row then matches nothing, and a screen that
--    should list forty service memos shows none. It looks exactly like data
--    loss and is not. So the backfill and the proof that it was complete are
--    deliberately the same transaction: if any table is short, the whole thing
--    rolls back and Phase 3 cannot be run against a half-filled database.
--
--  WHY `WHERE org_id IS NULL` RATHER THAN A BLANKET UPDATE
--    Phase 1 already set the column DEFAULT, so any row the firm created since
--    then is already stamped correctly. Touching only NULLs makes this file
--    idempotent — running it twice is a no-op — and means it can never
--    overwrite a value that is already right.
--
--  SAFE TO RUN WITH THE APP LIVE. Nothing reads org_id yet; the 82 existing
--  policies are still untouched.
--
--  ROLLBACK: db/2026-08-18_stage2_phase2_backfill_org_id_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  t          text;
  org        bigint;
  touched    bigint;
  total      bigint := 0;
  leftover   bigint;
  offenders  text := '';
  tables     text[] := array[
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
  ];
begin
  -- Resolved by slug, never hardcoded as 1. Identity columns are not
  -- guaranteed to start at 1 on a restored or rebuilt database, and this same
  -- file has to run correctly on staging, production and any future rebuild
  -- from db/00_bootstrap.sql.
  select id into strict org
  from public.organizations
  where slug = 'shailesh-associates';

  raise notice 'Backfilling to organisation % ...', org;

  foreach t in array tables loop
    execute format('update public.%I set org_id = $1 where org_id is null', t)
      using org;
    get diagnostics touched = row_count;
    total := total + touched;
    raise notice '  % rows  %', lpad(touched::text, 6), t;
  end loop;

  raise notice '% rows stamped across % tables', total, array_length(tables, 1);

  -- ── The gate ──────────────────────────────────────────────────────────────
  -- Re-read every table rather than trusting the UPDATE counts above: a row
  -- inserted by the app mid-migration would not be in those counts, and it is
  -- exactly the row most likely to be missed.
  foreach t in array tables loop
    execute format('select count(*) from public.%I where org_id is null', t)
      into leftover;
    if leftover > 0 then
      offenders := offenders || format('%s (%s rows), ', t, leftover);
    end if;
  end loop;

  if offenders <> '' then
    raise exception
      'Phase 2 incomplete — org_id still NULL in: %. Nothing has been committed. Do NOT run Phase 3.',
      rtrim(offenders, ', ');
  end if;

  raise notice 'VERIFIED: zero NULL org_id across all 22 tenant tables.';
end $$;


-- ── Verify (read-only, safe to re-run any time) ─────────────────────────────
-- Expect one row: total_rows 9161 · null_org_id 0 · distinct_orgs 1
--
-- 9,161 and NOT the 9,164 that tools/dbBackup.mjs reports. The backup counts
-- 23 tables; this counts the 22 that are tenant-owned. The missing 3 are
-- app_users, which has no org_id because org_members supersedes it. Anyone
-- reconciling these two numbers in future should expect exactly that gap
-- rather than hunting for lost rows.
--
-- distinct_orgs is the one that would catch a genuinely strange outcome —
-- more than one organisation in a database that only has one.
select
  sum(n)                        as total_rows,
  sum(nulls)                    as null_org_id,
  count(distinct org)           as distinct_orgs
from (
  select (select count(*) from clients) n,
         (select count(*) from clients where org_id is null) nulls,
         (select max(org_id) from clients) org
  union all select (select count(*) from client_shareholders),
         (select count(*) from client_shareholders where org_id is null),
         (select max(org_id) from client_shareholders)
  union all select (select count(*) from send_logs),
         (select count(*) from send_logs where org_id is null),
         (select max(org_id) from send_logs)
  union all select (select count(*) from audit_log),
         (select count(*) from audit_log where org_id is null),
         (select max(org_id) from audit_log)
  union all select (select count(*) from service_memos),
         (select count(*) from service_memos where org_id is null),
         (select max(org_id) from service_memos)
  union all select (select count(*) from service_memo_fee_skips),
         (select count(*) from service_memo_fee_skips where org_id is null),
         (select max(org_id) from service_memo_fee_skips)
  union all select (select count(*) from depreciation_schedules),
         (select count(*) from depreciation_schedules where org_id is null),
         (select max(org_id) from depreciation_schedules)
  union all select (select count(*) from bank_accounts),
         (select count(*) from bank_accounts where org_id is null),
         (select max(org_id) from bank_accounts)
  union all select (select count(*) from bank_transactions),
         (select count(*) from bank_transactions where org_id is null),
         (select max(org_id) from bank_transactions)
  union all select (select count(*) from party_opening_balances),
         (select count(*) from party_opening_balances where org_id is null),
         (select max(org_id) from party_opening_balances)
  union all select (select count(*) from financial_statements),
         (select count(*) from financial_statements where org_id is null),
         (select max(org_id) from financial_statements)
  union all select (select count(*) from projection_reports),
         (select count(*) from projection_reports where org_id is null),
         (select max(org_id) from projection_reports)
  union all select (select count(*) from document_register),
         (select count(*) from document_register where org_id is null),
         (select max(org_id) from document_register)
  union all select (select count(*) from saved_documents),
         (select count(*) from saved_documents where org_id is null),
         (select max(org_id) from saved_documents)
  union all select (select count(*) from audit_report_finalization),
         (select count(*) from audit_report_finalization where org_id is null),
         (select max(org_id) from audit_report_finalization)
  union all select (select count(*) from audit_checklists),
         (select count(*) from audit_checklists where org_id is null),
         (select max(org_id) from audit_checklists)
  union all select (select count(*) from work_done),
         (select count(*) from work_done where org_id is null),
         (select max(org_id) from work_done)
  union all select (select count(*) from work_todos),
         (select count(*) from work_todos where org_id is null),
         (select max(org_id) from work_todos)
  union all select (select count(*) from autobooks_books),
         (select count(*) from autobooks_books where org_id is null),
         (select max(org_id) from autobooks_books)
  union all select (select count(*) from autobooks_entries),
         (select count(*) from autobooks_entries where org_id is null),
         (select max(org_id) from autobooks_entries)
  union all select (select count(*) from autobooks_parties),
         (select count(*) from autobooks_parties where org_id is null),
         (select max(org_id) from autobooks_parties)
  union all select (select count(*) from autobooks_adjustments),
         (select count(*) from autobooks_adjustments where org_id is null),
         (select max(org_id) from autobooks_adjustments)
) s;
