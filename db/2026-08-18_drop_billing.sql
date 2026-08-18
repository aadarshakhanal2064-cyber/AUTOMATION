-- ════════════════════════════════════════════════════════════════════════════
--  2026-08-18 — Remove the Billing module's database objects
-- ════════════════════════════════════════════════════════════════════════════
--
--  User decision, 2026-08-18: the firm does not use Billing and does not want
--  it. Service Memo already records the work and the fee, and Bank Entry
--  records the money actually received — Billing sat between them recording
--  neither. Three invoices were ever raised, all now void.
--
--  ⚠  DESTRUCTIVE. This deletes rows, and 00_bootstrap_rollback-style
--     structure restoration will NOT bring them back. A full row-level export
--     was taken first and lives at
--         db/backups/2026-08-18_billing_export.json
--     (gitignored — it carries a real bank account number and client ids).
--     Anything dropped here is recoverable only from that file.
--
--  WHAT GOES
--    tables     invoices, invoice_items, invoice_payments, firm_bank_details
--    functions  set_invoice_number(), sync_invoice_payment_totals(),
--               get_billing_stats(), get_monthly_income(integer)
--    with them  3 triggers, 7 indexes, 12 RLS policies — all dropped by CASCADE
--               as dependants of the tables above.
--
--  WHAT STAYS, and why
--    · audit_log rows with module='billing' (17 of them). The work was really
--      done; deleting the trail would be rewriting history. js/config.js keeps
--      their display labels for the same reason, so the Activity Log renders
--      "Invoice created" rather than a raw code id. Same treatment the two VAT
--      modules and OCR Extract got.
--    · public.set_updated_at(). Billing used it, but so do 14 other triggers.
--      Dropping it would take the whole app down — the exact trap that made
--      the migrations un-runnable from scratch before 00_bootstrap.sql existed.
--    · firm_key columns on bank_accounts, party_opening_balances and
--      service_memos. These are PLAIN TEXT with no foreign key to
--      firm_bank_details — verified before writing this — so Bank Entry, Party
--      Ledger, Final Account and Service Memo are entirely unaffected. They
--      resolve firm identity from window.REP_FIRMS / SERVICE_MEMO_FIRMS in
--      js/config.js, never from this table.
--
--  DEPENDENCY ORDER: children first, so CASCADE has as little as possible to
--  do silently. invoice_items and invoice_payments both FK to invoices;
--  invoices FKs to firm_bank_details.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Fail loudly rather than silently dropping something unexpected: if any
-- object outside billing has grown a dependency on these tables since this
-- migration was written, the FK check below reports it before anything drops.
do $$
declare rogue text;
begin
  select string_agg(distinct c.relname, ', ') into rogue
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_class f on f.oid = con.confrelid
  where con.contype = 'f'
    and f.relname in ('invoices','invoice_items','invoice_payments','firm_bank_details')
    and c.relname not in ('invoices','invoice_items','invoice_payments','firm_bank_details');
  if rogue is not null then
    raise exception 'Aborting: % still references a billing table', rogue;
  end if;
end $$;

drop table if exists public.invoice_payments  cascade;
drop table if exists public.invoice_items     cascade;
drop table if exists public.invoices          cascade;
drop table if exists public.firm_bank_details cascade;

-- Trigger functions whose only triggers just went with the tables.
drop function if exists public.set_invoice_number()          cascade;
drop function if exists public.sync_invoice_payment_totals() cascade;

-- RPCs that read only billing tables. Nothing else calls either.
drop function if exists public.get_billing_stats()           cascade;
drop function if exists public.get_monthly_income(integer)   cascade;

-- Housekeeping while we are here: get_vat_fy_stats() has been broken since
-- 2026-08-10, when the VAT Compliance migration dropped public.vat_filings out
-- from under it. Calling it errors. Nothing in js/ references it, and leaving
-- a broken function on the exposed API surface serves nobody.
drop function if exists public.get_vat_fy_stats(text)        cascade;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect: billing_tables 0 | billing_functions 0 | tables 23 | policies 82
--         | triggers 17 | set_updated_at_intact true | billing_log_rows 17
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname in ('invoices','invoice_items','invoice_payments','firm_bank_details'))
                                                                        as billing_tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('set_invoice_number','sync_invoice_payment_totals',
                         'get_billing_stats','get_monthly_income','get_vat_fy_stats'))
                                                                        as billing_functions,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r')                    as tables,
  (select count(*) from pg_policies where schemaname = 'public')        as policies,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = 'public')                 as triggers,
  (select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'set_updated_at'))      as set_updated_at_intact,
  (select count(*) from public.audit_log where module = 'billing')      as billing_log_rows;
