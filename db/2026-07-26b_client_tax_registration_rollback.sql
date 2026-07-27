-- ============================================================================
--  ROLLBACK — 2026-07-26 (b) client master correction pass
-- ============================================================================
--  Reverses db/2026-07-26b_client_tax_registration.sql.
--
--  As with the first reload's rollback: this undoes the schema half cleanly.
--  The data half (the 56 business_nature corrections, the entity_type
--  normalization, the it_return_type reclassification) can only be undone by
--  restoring from a pre-correction snapshot, which is NOT checked in — this
--  repo is public and that snapshot is real client data. If you need it,
--  regenerate a snapshot of `clients` before running this rollback's data
--  half, or restore from your own backup taken before the correction pass ran.
-- ============================================================================

begin;

-- Dropping this column is lossless with respect to everything that existed
-- before 2026-07-26(b) — no feature from before that date reads it.
alter table public.clients drop column if exists tax_registration_type;

commit;

-- The business_nature/entity_type/it_return_type VALUES this migration wrote
-- over the 261 originals are not reconstructable from this repo. If exact
-- reversion is needed, restore `clients` from a snapshot taken before this
-- migration ran.
