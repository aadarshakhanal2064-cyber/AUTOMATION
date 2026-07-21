-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — Bank Book (2026-07-22)
--  Drops the Bank Book tables and everything created with them (triggers,
--  indexes and RLS policies fall with the tables). Drop the child table
--  first: bank_transactions references bank_accounts.
-- ════════════════════════════════════════════════════════════════════

drop table if exists public.bank_transactions cascade;
drop table if exists public.bank_accounts    cascade;
