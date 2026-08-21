-- ════════════════════════════════════════════════════════════════════
--  PERFORMANCE INDEXES — 2026-08-21 · Stage 1a of the overhaul plan
--
--  1) audit_log (created_at DESC). The Dashboard reads
--     "ORDER BY created_at DESC LIMIT n" on every open (326 GET + 316
--     HEAD calls in one measured day) and the only created_at index is
--     the composite (event_type, created_at), which cannot serve an
--     ORDER BY on created_at alone — today the query top-N-sorts the
--     whole table, which only ever grows (2,857 rows and counting).
--
--  2) Four covering indexes for FKs flagged by the Supabase advisor
--     (unindexed_foreign_keys). Cheap now, and they keep FK cascade
--     checks and future client-scoped lookups off sequential scans as
--     the tables grow.
--
--  All idempotent. Rollback: db/2026-08-21_perf_indexes_rollback.sql.
-- ════════════════════════════════════════════════════════════════════

create index if not exists audit_log_created_idx
  on public.audit_log (created_at desc);

create index if not exists bank_transactions_client_idx
  on public.bank_transactions (client_id);

create index if not exists bank_transactions_counterparty_idx
  on public.bank_transactions (counterparty_account_id);

create index if not exists provisional_statements_client_idx
  on public.provisional_statements (client_id);

create index if not exists service_memo_fee_skips_client_idx
  on public.service_memo_fee_skips (client_id);
