-- ════════════════════════════════════════════════════════════════════════
--  ROLLBACK — trial_balances (2026-08-30)
--
--  DESTRUCTIVE: this drops the table and every typed trial balance in it.
--  Nothing else in the app reads it, so there is no cascade to anything else,
--  but the ledgers themselves are gone. Export first if any real sheet exists:
--
--      node tools/orgAdmin.mjs export <org>      (writes to db/backups/)
--
--  The Trial Balance module cannot open at all without this table — it does
--  not degrade, it errors — so remove the module's script tag and its
--  Automation Hub entry in the same deploy.
-- ════════════════════════════════════════════════════════════════════════

drop table if exists public.trial_balances cascade;
