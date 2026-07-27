-- ============================================================================
--  ROLLBACK — 2026-07-27 it_return_type fix
-- ============================================================================
--  Restores the PREVIOUS (incorrect) split of 234 D1/D2 / 27 D-03, derived
--  from the old "any yellow cell on the row" rule.
--
--  You almost certainly do not want this. The old rule contradicts the only
--  two rows in the workbook that carry a typed "Type of IT return" value —
--  see the header of db/2026-07-27_fix_it_return_type.sql. This script exists
--  so the change is reversible, not because reverting is advisable.
--
--  PANS NOT COMMITTED — this repo is PUBLIC and PANs are client data. The 27
--  PANs the old rule classified as D-03 (rows with no yellow anywhere in the
--  data block) live in:
--
--      db/backups/2026-07-27_it_return_type_pans.sql   (gitignored)
--
--  Uncomment its _old_d3_pan block and run it at the point marked below.
-- ============================================================================

begin;

create temporary table _old_d3_pan (pan text primary key) on commit drop;

-- >>> run the _old_d3_pan block of
--     db/backups/2026-07-27_it_return_type_pans.sql here <<<

update public.clients
   set it_return_type = 'D1/D2'
 where id <= 262;

update public.clients c
   set it_return_type = 'D-03'
  from _old_d3_pan d
 where c.pan = d.pan
   and c.id <= 262;

commit;
