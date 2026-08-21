-- Rollback for 2026-08-22_provisional_statements.sql.
-- Destroys saved provisional statements — export first if any exist:
--   select count(*) from public.provisional_statements;

drop table if exists public.provisional_statements;
