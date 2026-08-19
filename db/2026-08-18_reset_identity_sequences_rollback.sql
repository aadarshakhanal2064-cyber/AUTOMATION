-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK of db/2026-08-18_reset_identity_sequences.sql
--
--  Drops the helper. The sequence values it already corrected STAY corrected —
--  they are table state, not something the function holds open — so removing
--  it does not reintroduce the duplicate-key failures, it only means a FUTURE
--  restore has no automatic fix and tools/dbRestore.mjs will warn that it
--  could not run.
-- ════════════════════════════════════════════════════════════════════════════

drop function if exists public.reset_identity_sequences();
