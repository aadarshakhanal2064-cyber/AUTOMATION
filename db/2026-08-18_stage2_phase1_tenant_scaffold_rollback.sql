-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK of db/2026-08-18_stage2_phase1_tenant_scaffold.sql
--
--  Phase 1 is additive, so this is a genuinely complete reversal: it drops
--  only objects that migration created, and the database returns to exactly
--  the schema it had before.
--
--  SAFE TO RUN even after Phase 2's backfill — the org_id values are dropped
--  with their columns and nothing else reads them. It is NOT safe once Phase 3
--  has rewritten the 82 policies to reference private.current_org_id(): those
--  policies would then reference a function that no longer exists. Roll Phase 3
--  back first (its own rollback file reinstates the membership-only policies).
--
--  WHAT IS LOST: nothing but the tenant scaffold itself — the organisation
--  row, the 3 member rows, the 5 letterhead rows, and 22 all-NULL (or
--  all-same-value) org_id columns. No client, ledger or document data is
--  touched at any point.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Drop org_id from the 22 tenant-owned tables ──────────────────────────
-- Dropping the column takes its index, its default and its foreign key with
-- it, so those need no separate statement. Same table list as the migration.
do $$
declare t text;
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
    execute format('alter table public.%I drop column if exists org_id', t);
  end loop;
end $$;

-- ── 2. Drop the three new tables ────────────────────────────────────────────
-- Child-before-parent. Policies, triggers and indexes go with the tables.
--
-- THESE MUST GO BEFORE THE FUNCTION, not after. All six policies created in
-- §6 of the migration call private.current_org_id(), and Postgres refuses to
-- drop a function a policy depends on. An earlier draft of this file dropped
-- the function first and failed with 2BP01 on the rehearsal — which is the
-- entire reason a rollback gets rehearsed rather than assumed.
drop table if exists public.org_firms;
drop table if exists public.org_members;
drop table if exists public.organizations;

-- ── 3. Drop the tenancy helper ──────────────────────────────────────────────
-- Safe only now: §1 took the org_id defaults that called it, and §2 took the
-- six policies. Deliberately NOT "drop ... cascade" — if anything still
-- depends on this, that is a Phase 3 policy and the drop SHOULD fail loudly
-- rather than silently strip tenant enforcement off the whole database.
drop function if exists private.current_org_id();

-- ── 4. Verify ───────────────────────────────────────────────────────────────
-- Expect every count 0 and current_org_id_exists f. app_users is untouched
-- throughout, so sign-in works exactly as before.
select
  (select count(*) from information_schema.tables
     where table_schema='public'
       and table_name in ('organizations','org_members','org_firms'))  as new_tables,
  (select count(*) from information_schema.columns
     where table_schema='public' and column_name='org_id')             as org_id_columns,
  (select count(*) from pg_indexes
     where schemaname='public' and indexname like '%\_org\_idx')       as org_indexes,
  (select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='current_org_id'))        as current_org_id_exists;
