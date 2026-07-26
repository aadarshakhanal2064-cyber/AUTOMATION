-- ============================================================================
--  ROLLBACK — 2026-07-26 client master reload
-- ============================================================================
--  Reverses db/2026-07-26_client_master_reload.sql.
--
--  IMPORTANT — read before running.
--
--  The forward migration did two different kinds of thing, and only one of
--  them is reversible by SQL alone:
--
--    * The 137 duplicate rows it DELETED (ids 325-461) are gone. They carried
--      no attached work and every one of them duplicated a PAN still held by
--      an original record, so nothing is lost by not restoring them — but this
--      script does not recreate them. If you genuinely need them back, restore
--      from the pre-migration snapshot in
--      db/backups/2026-07-26_clients_pre_reload.sql, which holds all 451 rows
--      exactly as they were. That file is GITIGNORED (real client PII in a
--      public repo) — it exists only on the machine that ran the migration.
--      If it is gone, the 451 rows are not recoverable from this repo.
--
--    * The overwritten name/address/entity_type/business_nature on the 261
--      original records cannot be reconstructed from the workbook, since the
--      workbook is what replaced them. They are in that same snapshot file.
--
--  So: step 1 below undoes the schema half (safe, always correct). To undo the
--  data half, use the snapshot.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Drop the columns the migration added
-- ---------------------------------------------------------------------------
-- Dropping these is lossless with respect to everything that existed before
-- 2026-07-26 — no pre-existing feature reads them.
alter table public.clients drop column if exists district;
alter table public.clients drop column if exists country;
alter table public.clients drop column if exists it_return_type;
alter table public.clients drop column if exists tax_type_d3;

commit;

-- ---------------------------------------------------------------------------
-- 2. To restore the row data, run the snapshot instead:
-- ---------------------------------------------------------------------------
--   \i db/backups/2026-07-26_clients_pre_reload.sql
--
-- That file truncates nothing; it upserts all 451 original rows by id and
-- resets the id sequence. Run it BEFORE step 1 if you want the old columns
-- populated, or after if you only want the pre-migration names back.
