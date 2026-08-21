-- ROLLBACK for 2026-08-21_perf_indexes.sql — drops the five indexes.
-- Data is untouched either way; dropping only restores the previous
-- (slower) query plans.

drop index if exists public.audit_log_created_idx;
drop index if exists public.bank_transactions_client_idx;
drop index if exists public.bank_transactions_counterparty_idx;
drop index if exists public.provisional_statements_client_idx;
drop index if exists public.service_memo_fee_skips_client_idx;
