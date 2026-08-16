-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — Autobooks ledger (2026-08-16)
--
--  Reverses db/2026-08-16_autobooks_ledger.sql.
--
--  ⚠ THIS DESTROYS DATA. autobooks_parties holds confirmation figures
--  typed from signed letters and autobooks_entries holds every bill line;
--  neither can be reconstructed from anywhere else in the app once dropped.
--  Take a backup first if any book has been saved:
--
--    -- from the Supabase SQL editor
--    select * from public.autobooks_books;
--    select * from public.autobooks_parties;
--
--  Dropping the tables drops their RLS policies, indexes, triggers and the
--  three ON DELETE CASCADE FKs to autobooks_books with them. Order matters
--  only in that the three children must go before the parent — CASCADE on
--  the parent drop would do it, but naming them is explicit about what is
--  being destroyed.
--
--  Nothing outside Autobooks references these tables.
-- ════════════════════════════════════════════════════════════════════

drop table if exists public.autobooks_adjustments;
drop table if exists public.autobooks_parties;
drop table if exists public.autobooks_entries;
drop table if exists public.autobooks_books;
