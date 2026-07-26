-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — db/2026-07-26_financial_suite.sql
--
--  Restores the pre-Party-Ledger shape. NOTE the asymmetry: re-adding the
--  service_memos payment columns restores the SCHEMA, not the data — any
--  amount_received / payment_date / payment_status values are gone once the
--  forward migration runs. That was accepted knowingly (5 memo rows, none
--  with a payment recorded). Same for party_opening_balances: dropping the
--  table discards every saved opening balance.
-- ════════════════════════════════════════════════════════════════════

-- ── 4. party_opening_balances ────────────────────────────────────────
drop table if exists public.party_opening_balances;   -- cascades its policies, indexes and trigger

-- ── 3. bank_transactions: back to the original four particulars ──────
-- Rows using the two new particulars must be reclassified first, or the
-- constraint can't be re-added. Expenses/Fee Receipt are the closest
-- equivalents in the old vocabulary.
update public.bank_transactions set particular = 'fee_receipt' where particular = 'for_tax';
update public.bank_transactions set particular = 'expenses'    where particular = 'tax_payment';

alter table public.bank_transactions
  drop constraint if exists bank_transactions_particular_check;

alter table public.bank_transactions
  add constraint bank_transactions_particular_check
  check (particular in ('fee_receipt', 'expenses', 'sapati', 'inter_bank_transfer'));

-- ── 2. bank_accounts ─────────────────────────────────────────────────
drop index if exists public.bank_accounts_firm_idx;
alter table public.bank_accounts drop column if exists firm_key;

-- ── 1. service_memos ─────────────────────────────────────────────────
alter table public.service_memos drop column if exists firm_other;

alter table public.service_memos
  add column if not exists payment_status text not null default 'pending'
    check (payment_status in ('pending', 'partially_paid', 'paid')),
  add column if not exists amount_received numeric(14,2) not null default 0,
  add column if not exists payment_date date;

create index if not exists service_memos_status_idx on public.service_memos (payment_status);
