-- Rollback for db/2026-08-15_service_memo_fee_skips.sql
-- Drops the table (and its policies/index with it). Data is gone; no
-- structure is left to restore from.

drop table if exists public.service_memo_fee_skips;
