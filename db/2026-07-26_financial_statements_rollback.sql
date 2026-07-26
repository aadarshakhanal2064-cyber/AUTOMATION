-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — financial_statements (2026-07-26)
--
--  Reverses db/2026-07-26_financial_statements.sql.
--
--  DESTRUCTIVE: dropping the table discards every saved statement
--  working. Those are re-derivable only by re-uploading each client's
--  prior-year workbook and re-entering the figures A-N, so export the
--  rows before running this if any real work has been saved:
--
--     select * from public.financial_statements;
--
--  Nothing references this table, so no FKs need re-pointing.
-- ════════════════════════════════════════════════════════════════════

drop trigger if exists set_financial_statements_updated_at on public.financial_statements;

drop policy if exists financial_statements_select_member on public.financial_statements;
drop policy if exists financial_statements_insert_member on public.financial_statements;
drop policy if exists financial_statements_update_member on public.financial_statements;
drop policy if exists financial_statements_delete_member on public.financial_statements;

drop index if exists public.financial_statements_client_fy_basis_idx;
drop index if exists public.financial_statements_fy_idx;
drop index if exists public.financial_statements_created_idx;

drop table if exists public.financial_statements;
