-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK — Autobooks CA workflow (2026-08-30)
--
--  DESTRUCTIVE: dropping these columns discards every confirmation tax-free
--  figure and every party classification typed since the migration was
--  applied. Those come off signed letters and off a preparer's judgement —
--  neither is re-derivable from the register. Export them first if the data
--  matters:
--
--    select book_id, section, party_key, party_name,
--           confirmed_taxfree, classify, classify_note
--      from public.autobooks_parties
--     where confirmed_taxfree is not null or classify is not null;
--
--  The app tolerates the columns being absent (it retries the write without
--  them and says the migration is pending), so this rollback leaves a working
--  application — just without those three fields.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.autobooks_parties
  drop column if exists confirmed_taxfree,
  drop column if exists classify,
  drop column if exists classify_note;
