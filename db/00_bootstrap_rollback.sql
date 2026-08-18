-- ════════════════════════════════════════════════════════════════════════════
--  00_bootstrap_rollback.sql — undo 00_bootstrap.sql
-- ════════════════════════════════════════════════════════════════════════════
--
--  ⚠  THIS DESTROYS EVERY TABLE AND EVERY ROW IN THEM. There is no undo, and
--     no rollback of the rollback. DROP ... CASCADE takes the data with it.
--
--  It exists for exactly one situation: a NEW, EMPTY Supabase project where
--  00_bootstrap.sql was applied and something needs redoing from scratch —
--  wrong project, half-applied run, a change to the bootstrap itself. At that
--  point there is nothing to lose, which is the only time this is safe.
--
--  NEVER run this against a project that holds real work. If you are unsure
--  whether a project holds real work, run this first and read the answer:
--
--    select (select count(*) from public.clients)  as clients,
--           (select count(*) from public.invoices) as invoices,
--           (select count(*) from public.audit_log) as log_rows;
--
--  Anything other than 0/0/0 means somebody's work is in here. Stop.
--
--  Supabase's own objects (auth.users and the rest of the auth schema, storage,
--  realtime) are NOT touched — this file only removes what the bootstrap made.
--  Staff logins therefore survive; their app_users membership rows do not, so
--  after re-bootstrapping, re-add the app_users rows (see 00_bootstrap.sql §11).
--
--  Order matters less than in the bootstrap because CASCADE handles the
--  dependencies, but tables are still dropped children-first so the CASCADE
--  has as little as possible to do silently.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Autobooks (children of autobooks_books) ─────────────────────────────────
drop table if exists public.autobooks_adjustments cascade;
drop table if exists public.autobooks_entries     cascade;
drop table if exists public.autobooks_parties     cascade;
drop table if exists public.autobooks_books       cascade;

-- ── Billing (children of invoices) ──────────────────────────────────────────
drop table if exists public.invoice_payments cascade;
drop table if exists public.invoice_items    cascade;
drop table if exists public.invoices         cascade;

-- ── Work tracking ───────────────────────────────────────────────────────────
drop table if exists public.work_todos                cascade;
drop table if exists public.work_done                 cascade;
drop table if exists public.audit_checklists          cascade;
drop table if exists public.audit_report_finalization cascade;
drop table if exists public.document_register         cascade;

-- ── Automation Hub ──────────────────────────────────────────────────────────
drop table if exists public.saved_documents        cascade;
drop table if exists public.projection_reports     cascade;
drop table if exists public.financial_statements   cascade;
drop table if exists public.depreciation_schedules cascade;

-- ── Financial management ────────────────────────────────────────────────────
drop table if exists public.service_memo_fee_skips  cascade;
drop table if exists public.service_memos           cascade;
drop table if exists public.party_opening_balances  cascade;
drop table if exists public.bank_transactions       cascade;
drop table if exists public.bank_accounts           cascade;

-- ── Roots (last — everything above references these) ────────────────────────
drop table if exists public.client_shareholders cascade;
drop table if exists public.clients             cascade;
drop table if exists public.firm_bank_details   cascade;
drop table if exists public.send_logs           cascade;
drop table if exists public.audit_log           cascade;
drop table if exists public.app_users           cascade;

-- ── Functions ───────────────────────────────────────────────────────────────
-- The trigger functions outlive their triggers (dropped with the tables above),
-- so they need removing explicitly.
drop function if exists public.get_db_storage_usage()          cascade;
drop function if exists public.get_monthly_income(integer)     cascade;
drop function if exists public.get_billing_stats()             cascade;
drop function if exists public.sync_invoice_payment_totals()   cascade;
drop function if exists public.set_document_register_number()  cascade;
drop function if exists public.set_service_memo_number()       cascade;
drop function if exists public.set_invoice_number()            cascade;
drop function if exists public.set_updated_at()                cascade;

-- ── The private schema and its three helpers ────────────────────────────────
drop schema if exists private cascade;

-- ── Confirm it is clean before re-running the bootstrap ─────────────────────
-- Expect 0 / 0 / 0. Anything else and the bootstrap will error partway.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r')      as tables_left,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public')                        as public_functions_left,
  (select count(*) from pg_namespace where nspname='private') as private_schema_left;
